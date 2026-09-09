import { and, eq, sql } from 'drizzle-orm';
import type { CreditTransaction } from '../credit-transaction';
import { integrationMonthlyUsage } from '../schema';
import type {
  EntitlementSnapshot,
  EntitlementIdentity,
} from '../../../shared/billing/entitlement';
import type { DispatchRecord } from './verification-message-dispatches.repository';

export class PeriodicPlanAccounting {
  async reserve(
    tx: CreditTransaction,
    params: EntitlementIdentity & { integrationId: string },
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
    if (usage.consumedCount >= entitlement.includedLimit) {
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
        reason: 'plan_limit_reached',
        consumedCount: usage.consumedCount,
        includedLimit: entitlement.includedLimit,
      };
    }
    await tx
      .update(integrationMonthlyUsage)
      .set({
        consumedCount: sql`${integrationMonthlyUsage.consumedCount} + 1`,
        includedLimit: entitlement.includedLimit,
        updatedAt: now,
      })
      .where(eq(integrationMonthlyUsage.id, usage.id));
    return { allowed: true as const };
  }
  async release(
    tx: CreditTransaction,
    dispatch: Pick<
      DispatchRecord,
      'integrationId' | 'usagePeriodStart' | 'usageReserved'
    >,
    occurredAt: string,
  ): Promise<void> {
    if (!dispatch.usageReserved || !dispatch.usagePeriodStart) return;
    const released = await tx
      .update(integrationMonthlyUsage)
      .set({
        consumedCount: sql`GREATEST(${integrationMonthlyUsage.consumedCount} - 1, 0)`,
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
    dispatch: Pick<DispatchRecord, 'integrationId' | 'usagePeriodStart'>,
    occurredAt: string,
  ): Promise<void> {
    const restored = await tx
      .update(integrationMonthlyUsage)
      .set({
        consumedCount: sql`${integrationMonthlyUsage.consumedCount} + 1`,
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
