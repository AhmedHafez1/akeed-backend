import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { CreditTransaction } from '../credit-transaction';
import { integrationMonthlyUsage } from '../schema';
import type {
  EntitlementSnapshot,
  EntitlementIdentity,
} from '../../../shared/billing/entitlement';
import {
  decidePeriodicCharge,
  type ChargeRule,
  type SenderKind,
} from '../../../shared/billing/own-number-billing.policy';
import { decideShippingCharge } from '../../../shared/billing/shipping-charge.policy';
import type { DispatchRecord } from './verification-message-dispatches.repository';

type RecordedBilling = Pick<
  DispatchRecord,
  'integrationId' | 'usagePeriodStart' | 'billingPool' | 'billingCost'
>;

/**
 * The usage column and amount a dispatch moved. A row claimed before billing
 * was recorded took one message from the Akeed pool.
 */
function recordedUsage(dispatch: RecordedBilling) {
  return dispatch.billingPool === 'own_number'
    ? {
        column: integrationMonthlyUsage.ownNumberConsumed,
        field: 'ownNumberConsumed' as const,
        cost: dispatch.billingCost ?? 0,
      }
    : {
        column: integrationMonthlyUsage.consumedCount,
        field: 'consumedCount' as const,
        cost: dispatch.billingCost ?? 1,
      };
}

/**
 * A whole number of messages as a literal, so the statement for an Akeed-number
 * send reads exactly as it always has (`+ 1`, `- 1`).
 */
function units(cost: number) {
  if (!Number.isSafeInteger(cost) || cost < 0)
    throw new Error('Usage cost must be a non-negative integer');
  return sql.raw(String(cost));
}

@Injectable()
export class PeriodicPlanAccounting {
  async reserve(
    tx: CreditTransaction,
    params: EntitlementIdentity & {
      integrationId: string;
      senderKind?: SenderKind;
      chargeRule?: ChargeRule;
      /** The dispatch kind; a shipping message keeps the D3 reserve. */
      kind?: string;
    },
    entitlement: EntitlementSnapshot,
    now: string,
  ) {
    await tx
      .insert(integrationMonthlyUsage)
      .values({
        orgId: params.orgId,
        integrationId: params.integrationId,
        periodStart: entitlement.periodStart,
        includedLimit: entitlement.includedLimit,
      })
      .onConflictDoNothing();
    const [usage] = await tx
      .select()
      .from(integrationMonthlyUsage)
      .where(
        and(
          eq(integrationMonthlyUsage.integrationId, params.integrationId),
          eq(integrationMonthlyUsage.periodStart, entitlement.periodStart),
        ),
      )
      .for('update');
    if (!usage) throw new Error('Usage row missing after reservation upsert');
    const sender = params.senderKind ?? 'akeed_system';
    const rule = params.chargeRule ?? 'standard';
    const ownLimit = entitlement.ownNumberIncludedLimit;
    const snapshot = {
      akeedUsed: usage.consumedCount,
      akeedLimit: entitlement.includedLimit,
      ownUsed: usage.ownNumberConsumed,
      ownLimit,
    };
    if (params.kind === 'shipping_shipped') {
      // Shipping uses the same pools as confirmations, decided under the same
      // usage-row lock as the charge. A refusal is not a blocked
      // confirmation, so the blocked count is left alone.
      const shipping = decideShippingCharge({
        sender,
        chargeRule: rule,
        snapshot,
      });
      if (!shipping.allowed)
        return {
          allowed: false as const,
          reason: shipping.reason,
          consumedCount: usage.consumedCount,
          includedLimit: entitlement.includedLimit,
        };
      return this.charge(tx, usage, shipping, sender, rule, entitlement, now);
    }
    // A fallback is an Akeed-number send: the rule only changes how usage
    // is reported below.
    const charge = decidePeriodicCharge({ sender, snapshot });
    if (!charge.allowed) {
      await tx
        .update(integrationMonthlyUsage)
        .set({
          blockedCount: sql`${integrationMonthlyUsage.blockedCount} + 1`,
          includedLimit: entitlement.includedLimit,
          updatedAt: now,
        })
        .where(eq(integrationMonthlyUsage.id, usage.id));
      return {
        allowed: false as const,
        reason: charge.reason,
        consumedCount: usage.consumedCount,
        includedLimit: entitlement.includedLimit,
      };
    }
    return this.charge(tx, usage, charge, sender, rule, entitlement, now);
  }

  private async charge(
    tx: CreditTransaction,
    usage: typeof integrationMonthlyUsage.$inferSelect,
    charge: { pool: 'akeed' | 'own_number'; cost: number },
    sender: SenderKind,
    rule: ChargeRule,
    entitlement: EntitlementSnapshot,
    now: string,
  ) {
    const ownLimit = entitlement.ownNumberIncludedLimit;
    const own = charge.pool === 'own_number';
    await tx
      .update(integrationMonthlyUsage)
      .set({
        ...(own
          ? {
              ownNumberConsumed: sql`${integrationMonthlyUsage.ownNumberConsumed} + ${units(charge.cost)}`,
            }
          : {
              consumedCount: sql`${integrationMonthlyUsage.consumedCount} + ${units(charge.cost)}`,
            }),
        includedLimit: entitlement.includedLimit,
        updatedAt: now,
      })
      .where(eq(integrationMonthlyUsage.id, usage.id));
    // Akeed-number sends report the Akeed pool, exactly as before. Anything
    // that involves the merchant's number reports both pools together.
    const combined = sender === 'merchant_own' || rule === 'fallback';
    const before = combined
      ? usage.consumedCount + usage.ownNumberConsumed
      : usage.consumedCount;
    return {
      allowed: true as const,
      pool: charge.pool,
      cost: charge.cost,
      consumedBefore: before,
      consumedAfter: before + charge.cost,
      includedLimit: combined
        ? entitlement.includedLimit + ownLimit
        : entitlement.includedLimit,
    };
  }

  async release(
    tx: CreditTransaction,
    dispatch: RecordedBilling & Pick<DispatchRecord, 'usageReserved'>,
    occurredAt: string,
  ): Promise<void> {
    if (!dispatch.usageReserved || !dispatch.usagePeriodStart) return;
    const usage = recordedUsage(dispatch);
    const released = await tx
      .update(integrationMonthlyUsage)
      .set({
        [usage.field]: sql`GREATEST(${usage.column} - ${units(usage.cost)}, 0)`,
        updatedAt: occurredAt,
      })
      .where(
        and(
          eq(integrationMonthlyUsage.integrationId, dispatch.integrationId),
          eq(integrationMonthlyUsage.periodStart, dispatch.usagePeriodStart),
        ),
      )
      .returning({ id: integrationMonthlyUsage.id });
    if (released.length === 0) {
      throw new Error('Usage row missing while refunding failed dispatch');
    }
  }

  async restore(
    tx: CreditTransaction,
    dispatch: RecordedBilling,
    occurredAt: string,
  ): Promise<void> {
    const usage = recordedUsage(dispatch);
    const restored = await tx
      .update(integrationMonthlyUsage)
      .set({
        [usage.field]: sql`${usage.column} + ${units(usage.cost)}`,
        updatedAt: occurredAt,
      })
      .where(
        and(
          eq(integrationMonthlyUsage.integrationId, dispatch.integrationId),
          eq(integrationMonthlyUsage.periodStart, dispatch.usagePeriodStart!),
        ),
      )
      .returning({ id: integrationMonthlyUsage.id });
    if (restored.length === 0) {
      throw new Error('Usage row missing while restoring accepted dispatch');
    }
  }
}
