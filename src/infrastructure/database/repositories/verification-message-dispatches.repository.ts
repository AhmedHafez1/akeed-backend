import { Inject, Injectable } from '@nestjs/common';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolveEntitlement } from '../../../shared/billing/entitlement';
import type { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import { TERMINAL_STATUSES } from '../../../shared/verification/verification-lifecycle';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  integrationMonthlyUsage,
  integrations,
  verificationMessageDispatches,
  verifications,
} from '../schema';

/**
 * Projects a lifecycle status onto a verification without regressing a
 * terminal one.
 *
 * The dispatch ledger records facts about the outbound message (it was
 * accepted, it was rejected). Those facts stay true even when the customer has
 * already replied, so the surrounding columns must still be written — but the
 * `status` column must not walk a `confirmed`/`canceled` row backwards.
 *
 * Expressed as a CASE rather than a WHERE guard on purpose: a WHERE guard
 * would drop `wa_message_id`, `last_sent_at` and `attempts` along with the
 * status, losing the ledger record of a message that really was sent.
 */
function statusUnlessTerminal(status: VerificationStatus) {
  return sql`CASE
    WHEN ${verifications.status} IN ('confirmed', 'canceled') THEN ${verifications.status}
    ELSE ${status}::verification_status
  END`;
}

/**
 * Raise a verification to `sent` only when it is still claiming nothing was
 * sent.
 *
 * Unlike {@link statusUnlessTerminal}, this never moves a row backwards. It is
 * for writes that prove *a* message reached the provider without proving it is
 * the newest one — repairing a lagging projection, or recording an accepted
 * follow-up. A row already at `delivered`/`read`/`no_reply` keeps the further
 * state it earned.
 */
const sentFloor = sql`CASE
  WHEN ${verifications.status} IS NULL OR ${verifications.status} = 'pending'
    THEN 'sent'::verification_status
  ELSE ${verifications.status}
END`;

export type DispatchKind = 'initial' | 'follow_up';
export type DispatchRecord = typeof verificationMessageDispatches.$inferSelect;
export type DispatchState = DispatchRecord['state'];

/**
 * How many times one logical send may be re-claimed after its lease expires.
 *
 * An expired lease proves the previous worker died before it recorded an
 * acceptance, but not whether it died before or after reaching the provider —
 * so every reclaim risks a duplicate message to the customer. One retry buys
 * back the overwhelmingly common case (the process was interrupted mid-send)
 * without letting an ambiguous dispatch loop; past the cap it goes to staff
 * resolution instead.
 */
const MAX_LEASE_RECLAIM_ATTEMPTS = 2;

/**
 * A write target that may be either the pool or an open transaction, so the
 * acceptance projection can run inside `markAccepted`'s transaction or on its
 * own when the ledger write itself could not be applied.
 */
type DispatchWriter =
  | PostgresJsDatabase<typeof schema>
  | Parameters<
      Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]
    >[0];

/**
 * Outcome of applying a provider acceptance to the ledger.
 *
 * Deliberately discriminated rather than `DispatchRecord | undefined`: the
 * caller has to log *why* an acceptance could not be applied, and the four
 * causes (row gone, wrong state, and the two acceptable states) used to
 * collapse into one indistinguishable `undefined`.
 */
export type DispatchAcceptanceResult =
  | { outcome: 'accepted'; dispatch: DispatchRecord }
  | { outcome: 'not_found' }
  | {
      outcome: 'unacceptable_state';
      state: DispatchState;
      attemptCount: number;
    };

export type DispatchClaimResult =
  | { outcome: 'claimed'; dispatch: DispatchRecord }
  | {
      outcome: 'blocked';
      reason: string;
      consumedCount?: number;
      includedLimit?: number;
    }
  | {
      outcome: 'busy' | 'accepted' | 'outcome_unknown';
      dispatch: DispatchRecord;
    };

@Injectable()
export class VerificationMessageDispatchesRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async claim(params: {
    orgId: string;
    integrationId: string;
    verificationId: string;
    kind: DispatchKind;
    templateName: string;
    languageCode: string;
    leaseUntil: string;
  }): Promise<DispatchClaimResult> {
    const dispatchKey = `${params.verificationId}:${params.kind}:1`;
    const now = new Date().toISOString();

    return this.db.transaction(async (tx) => {
      await tx
        .insert(verificationMessageDispatches)
        .values({
          orgId: params.orgId,
          integrationId: params.integrationId,
          verificationId: params.verificationId,
          dispatchKey,
          kind: params.kind,
          state: 'ready',
          templateName: params.templateName,
          languageCode: params.languageCode,
        })
        .onConflictDoNothing({
          target: verificationMessageDispatches.dispatchKey,
        });

      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.dispatchKey, dispatchKey))
        .for('update');
      if (
        !dispatch ||
        dispatch.orgId !== params.orgId ||
        dispatch.integrationId !== params.integrationId ||
        dispatch.verificationId !== params.verificationId
      ) {
        throw new Error('Dispatch identity mismatch');
      }
      if (dispatch.state === 'accepted') {
        return { outcome: 'accepted' as const, dispatch };
      }
      if (dispatch.state === 'outcome_unknown') {
        return { outcome: 'outcome_unknown' as const, dispatch };
      }
      // An expired lease is the only signal that the worker holding this send
      // died before it could record an acceptance. Re-claiming it here is what
      // lets the verification leave `pending`: parking it at `outcome_unknown`
      // stranded the row for good, because every later claim then returned
      // early without sending and only staff resolution could free it.
      let reclaimedFromExpiredLease = false;
      if (dispatch.state === 'sending') {
        if (
          !dispatch.leaseUntil ||
          new Date(dispatch.leaseUntil) > new Date()
        ) {
          return { outcome: 'busy' as const, dispatch };
        }
        if (dispatch.attemptCount >= MAX_LEASE_RECLAIM_ATTEMPTS) {
          const [unknown] = await tx
            .update(verificationMessageDispatches)
            .set({
              state: 'outcome_unknown',
              lastErrorCode: 'dispatch_lease_expired',
              leaseUntil: null,
              updatedAt: now,
            })
            .where(eq(verificationMessageDispatches.id, dispatch.id))
            .returning();
          return { outcome: 'outcome_unknown' as const, dispatch: unknown };
        }
        // Falls through to the claim below. `usageReserved` is already true, so
        // the reservation block is skipped and the merchant is not charged
        // twice for the same logical send.
        reclaimedFromExpiredLease = true;
      }

      const [source] = await tx
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.id, params.integrationId),
            eq(integrations.orgId, params.orgId),
          ),
        )
        .for('update');
      const entitlement = resolveEntitlement(source, {
        id: params.integrationId,
        orgId: params.orgId,
      });
      if (!entitlement.allowed) {
        return {
          outcome: 'blocked' as const,
          reason: entitlement.reason ?? 'billing_not_active',
        };
      }

      if (!dispatch.usageReserved) {
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
        if (!usage)
          throw new Error('Usage row missing after reservation upsert');
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
            outcome: 'blocked' as const,
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
      }

      const [claimed] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'sending',
          templateName: params.templateName,
          languageCode: params.languageCode,
          usagePeriodStart:
            dispatch.usagePeriodStart ?? entitlement.periodStart,
          usageReserved: true,
          attemptCount: sql`${verificationMessageDispatches.attemptCount} + 1`,
          // Keep the reason the previous attempt was abandoned; it is the only
          // trace that this send is a reclaim rather than a first try.
          lastErrorCode: reclaimedFromExpiredLease
            ? 'dispatch_lease_expired'
            : null,
          leaseUntil: params.leaseUntil,
          updatedAt: now,
        })
        .where(eq(verificationMessageDispatches.id, dispatch.id))
        .returning();
      return { outcome: 'claimed' as const, dispatch: claimed };
    });
  }

  async markAccepted(params: {
    dispatchId: string;
    providerMessageId: string;
    sentAt: string;
  }): Promise<DispatchAcceptanceResult> {
    return this.db.transaction(async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, params.dispatchId))
        .for('update');
      if (!dispatch) return { outcome: 'not_found' as const };

      // Project first, on every path that represents an accepted send —
      // including a dispatch already marked `accepted`.
      //
      // The ledger and the verification are written in this one transaction, so
      // they cannot diverge going forward; but rows that diverged before this
      // (migration 0028 backfilled `accepted` dispatches without touching
      // `verifications.status`) used to be frozen here forever, because the
      // early return skipped the projection and no later send would retry it.
      // The projection is idempotent and terminal-guarded, so re-running it can
      // only ever pull a lagging row forward.
      if (dispatch.state === 'accepted') {
        await this.projectAcceptedVerification(tx, dispatch, {
          // Preserve the original acceptance facts; this is a repair, not a resend.
          providerMessageId:
            dispatch.providerMessageId ?? params.providerMessageId,
          sentAt: dispatch.acceptedAt ?? params.sentAt,
          repair: true,
        });
        return { outcome: 'accepted' as const, dispatch };
      }
      if (
        dispatch.state !== 'sending' &&
        dispatch.state !== 'outcome_unknown'
      ) {
        return {
          outcome: 'unacceptable_state' as const,
          state: dispatch.state,
          attemptCount: dispatch.attemptCount,
        };
      }
      await this.projectAcceptedVerification(tx, dispatch, params);
      const [updated] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'accepted',
          providerMessageId: params.providerMessageId,
          acceptedAt: params.sentAt,
          resolvedAt:
            dispatch.state === 'outcome_unknown' ? params.sentAt : null,
          lastErrorCode: null,
          leaseUntil: null,
          updatedAt: params.sentAt,
        })
        .where(eq(verificationMessageDispatches.id, dispatch.id))
        .returning();
      return { outcome: 'accepted' as const, dispatch: updated };
    });
  }

  /**
   * Records a provider acceptance on the verification when the ledger write
   * could not be applied to it.
   *
   * The provider returned a message id, so the message really was sent.
   * Discarding that used to leave the row `failed` with a NULL
   * `wa_message_id` — which also broke the delivery and read webhooks (they
   * resolve against that id) and zeroed every `last_sent_at`-derived dashboard
   * metric. The ledger anomaly is real and still recorded separately, but it
   * must not overwrite what the provider already told us.
   */
  async projectAcceptanceWithoutLedger(params: {
    verificationId: string;
    kind: DispatchKind;
    providerMessageId: string;
    sentAt: string;
  }): Promise<void> {
    await this.projectAcceptedVerification(
      this.db,
      { verificationId: params.verificationId, kind: params.kind },
      {
        providerMessageId: params.providerMessageId,
        sentAt: params.sentAt,
      },
    );
  }

  async markOutcomeUnknown(
    dispatchId: string,
    errorCode: string,
  ): Promise<void> {
    await this.db
      .update(verificationMessageDispatches)
      .set({
        state: 'outcome_unknown',
        lastErrorCode: errorCode,
        leaseUntil: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(verificationMessageDispatches.id, dispatchId),
          eq(verificationMessageDispatches.state, 'sending'),
        ),
      );
  }

  async findByProviderMessageId(providerMessageId: string) {
    return this.db.query.verificationMessageDispatches.findFirst({
      where: eq(
        verificationMessageDispatches.providerMessageId,
        providerMessageId,
      ),
    });
  }

  async recordProviderStatus(
    dispatchId: string,
    status: 'delivered' | 'read' | 'failed',
    occurredAt: string,
  ): Promise<void> {
    const updates =
      status === 'delivered'
        ? { deliveredAt: occurredAt }
        : status === 'read'
          ? { deliveredAt: occurredAt, readAt: occurredAt }
          : { failedAt: occurredAt };
    await this.db
      .update(verificationMessageDispatches)
      .set({ ...updates, updatedAt: occurredAt })
      .where(eq(verificationMessageDispatches.id, dispatchId));
  }

  async findUnknownById(id: string) {
    return this.db.query.verificationMessageDispatches.findFirst({
      where: and(
        eq(verificationMessageDispatches.id, id),
        eq(verificationMessageDispatches.state, 'outcome_unknown'),
      ),
      with: {
        verification: { with: { order: { with: { integration: true } } } },
      },
    });
  }

  async findById(id: string) {
    return this.db.query.verificationMessageDispatches.findFirst({
      where: eq(verificationMessageDispatches.id, id),
      with: {
        verification: {
          with: { order: { with: { integration: true, webhookEvents: true } } },
        },
      },
    });
  }

  async resolveNotAccepted(id: string): Promise<DispatchRecord | undefined> {
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, id))
        .for('update');
      if (!dispatch) return undefined;
      if (dispatch.state === 'rejected') return dispatch;
      if (dispatch.state !== 'outcome_unknown') return undefined;
      if (dispatch.usageReserved && dispatch.usagePeriodStart) {
        await tx
          .update(integrationMonthlyUsage)
          .set({
            consumedCount: sql`GREATEST(${integrationMonthlyUsage.consumedCount} - 1, 0)`,
            updatedAt: now,
          })
          .where(
            and(
              eq(integrationMonthlyUsage.integrationId, dispatch.integrationId),
              eq(
                integrationMonthlyUsage.periodStart,
                dispatch.usagePeriodStart,
              ),
            ),
          );
      }
      const [updated] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'rejected',
          usageReserved: false,
          resolvedAt: now,
          lastErrorCode: 'provider_not_accepted',
          updatedAt: now,
        })
        .where(eq(verificationMessageDispatches.id, id))
        .returning();
      await tx
        .update(verifications)
        .set({
          status: statusUnlessTerminal('failed'),
          metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ reason: 'provider_not_accepted', kind: dispatch.kind })}::jsonb`,
          updatedAt: now,
        })
        .where(eq(verifications.id, dispatch.verificationId));
      return updated;
    });
  }

  private async projectAcceptedVerification(
    tx: DispatchWriter,
    dispatch: Pick<DispatchRecord, 'kind' | 'verificationId'>,
    params: { providerMessageId: string; sentAt: string; repair?: boolean },
  ): Promise<void> {
    const common = {
      waMessageId: params.providerMessageId,
      updatedAt: params.sentAt,
    };
    if (dispatch.kind === 'follow_up') {
      // A follow-up must never repoint `wa_message_id` on a verification the
      // customer has already answered, or later delivery/read webhooks would
      // resolve against a terminal row — hence the terminal guard below.
      //
      // It does still carry a `sent` floor: an accepted follow-up proves a
      // message reached the provider, so the row must not be left claiming
      // nothing has been sent. `sentFloor` only lifts `pending`/NULL, so a row
      // already at `delivered`/`read`/`no_reply` keeps the further state it
      // earned.
      await tx
        .update(verifications)
        .set({
          ...common,
          status: sentFloor,
          followUpSentAt: params.sentAt,
          followUpAttempts: sql`${verifications.followUpAttempts} + 1`,
        })
        .where(
          and(
            eq(verifications.id, dispatch.verificationId),
            notInArray(verifications.status, TERMINAL_STATUSES),
          ),
        );
      return;
    }
    // A fresh send restarts the lifecycle, so it sets `sent` outright. A repair
    // re-states an acceptance that already happened, so it may only raise a
    // floor — walking a `delivered`/`read` row back to `sent` would replace one
    // wrong answer with another — and it must not inflate the attempt count.
    await tx
      .update(verifications)
      .set({
        ...common,
        status: params.repair ? sentFloor : statusUnlessTerminal('sent'),
        lastSentAt: params.repair
          ? sql`COALESCE(${verifications.lastSentAt}, ${params.sentAt})`
          : params.sentAt,
        ...(params.repair
          ? {}
          : { attempts: sql`COALESCE(${verifications.attempts}, 0) + 1` }),
        metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) - 'reason' - 'kind'`,
      })
      .where(eq(verifications.id, dispatch.verificationId));
  }
}
