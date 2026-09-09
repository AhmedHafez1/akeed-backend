import type { CreditTransaction } from '../credit-transaction';
import { UsageAccountingRouter } from './usage-accounting.router';
import { reconciliationRequired } from './prepaid-credit-accounting';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { resolveEntitlement } from '../../../shared/billing/entitlement';
import type { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import { TERMINAL_STATUSES } from '../../../shared/verification/verification-lifecycle';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  adminAccessAudit,
  creditAccounts,
  integrationMonthlyUsage,
  orders,
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

/**
 * The logical identity of one send: a verification, a kind, and an attempt
 * generation. Unlike the surrogate primary key it can be derived from what the
 * caller already knows, which is what makes an acceptance recoverable when the
 * id it was handed no longer resolves.
 */
export function buildDispatchKey(
  verificationId: string,
  kind: DispatchKind,
  generation = 1,
): string {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > 2147483647
  ) {
    throw new Error('Dispatch generation must be a positive database integer');
  }
  return `${verificationId}:${kind}:${generation}`;
}
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
  | DrizzleDB
  | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/**
 * Outcome of applying a provider acceptance to the ledger.
 *
 * Deliberately discriminated rather than `DispatchRecord | undefined`: the
 * caller has to log *why* an acceptance could not be applied, and the four
 * causes (row gone, wrong state, and the two acceptable states) used to
 * collapse into one indistinguishable `undefined`.
 *
 * `verification_missing` is separated from `not_found` because the two demand
 * different responses. A missing ledger row can still be salvaged onto the
 * verification; a missing verification means the cascade took both, nothing is
 * left to write to, and the send that already reached the customer is orphaned.
 */
export type DispatchAcceptanceResult =
  | { outcome: 'accepted'; dispatch: DispatchRecord }
  | { outcome: 'not_found' }
  | { outcome: 'verification_missing' }
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
    private readonly db: DrizzleDB,
    private readonly accounting: UsageAccountingRouter,
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
    const dispatchKey = buildDispatchKey(params.verificationId, params.kind);
    const now = new Date().toISOString();

    return this.db.transaction(async (tx) => {
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

      if (
        source &&
        this.accounting.mode(source.platformType) === 'prepaid_credit'
      ) {
        if (!source.isActive)
          return {
            outcome: 'blocked' as const,
            reason: 'integration_inactive',
          };
        return this.claimPrepaid(tx, params);
      }

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
      // A row already bound to prepaid credits owns a reservation and a ledger
      // identity. Reaching here means credit billing was switched off after the
      // row was created, and re-claiming it would reserve monthly usage for a
      // send the credit system is still accounting for. Park it for staff
      // instead of billing it twice on two systems.
      if (dispatch.accountingMode === 'prepaid_credit') {
        return {
          outcome: 'blocked' as const,
          reason: 'PAYMENT_PENDING_RECONCILIATION',
        };
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
        const reservation = await this.accounting.periodic.reserve(
          tx,
          { ...params, id: params.integrationId },
          entitlement,
          now,
        );
        if (!reservation.allowed)
          return {
            outcome: 'blocked' as const,
            reason: reservation.reason,
            consumedCount: reservation.consumedCount,
            includedLimit: reservation.includedLimit,
          };
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
    verificationId?: string;
    kind?: DispatchKind;
    generation?: number;
    staffAudit?: { userId: string; reason: string };
  }): Promise<DispatchAcceptanceResult> {
    return this.withDispatchTransaction(
      params.dispatchId,
      async (tx) => {
        let [dispatch] = await tx
          .select()
          .from(verificationMessageDispatches)
          .where(eq(verificationMessageDispatches.id, params.dispatchId))
          .for('update');
        if (!dispatch && params.verificationId && params.kind) {
          // The id missed, but a dispatch is also addressable by its logical key,
          // which the caller can always rebuild. Recovering here turns a stale or
          // superseded id -- something this side can repair -- into a normal
          // acceptance instead of an orphaned send.
          [dispatch] = await tx
            .select()
            .from(verificationMessageDispatches)
            .where(
              eq(
                verificationMessageDispatches.dispatchKey,
                buildDispatchKey(
                  params.verificationId,
                  params.kind,
                  params.generation,
                ),
              ),
            )
            .for('update');
        }
        if (!dispatch) {
          // Neither key resolves. If the verification is gone too, the cascade on
          // its foreign key is the explanation and there is nothing left to write
          // to -- say so, rather than reporting an indistinguishable missing row.
          if (params.verificationId) {
            const [verification] = await tx
              .select({ id: verifications.id })
              .from(verifications)
              .where(eq(verifications.id, params.verificationId));
            if (!verification) {
              return { outcome: 'verification_missing' as const };
            }
          }
          return { outcome: 'not_found' as const };
        }

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
          if (
            (params.staffAudit ||
              dispatch.accountingMode === 'prepaid_credit') &&
            dispatch.providerMessageId !== params.providerMessageId
          )
            throw new ConflictException('Dispatch resolution conflict');
          if (dispatch.accountingMode === 'prepaid_credit') {
            await this.accounting.prepaid.transition(
              tx,
              dispatch,
              'consume',
              params.staffAudit?.userId,
            );
            const [newer] = await tx
              .select({ id: verificationMessageDispatches.id })
              .from(verificationMessageDispatches)
              .where(
                and(
                  eq(
                    verificationMessageDispatches.verificationId,
                    dispatch.verificationId,
                  ),
                  eq(verificationMessageDispatches.kind, dispatch.kind),
                  sql`${verificationMessageDispatches.generation} > ${dispatch.generation}`,
                ),
              )
              .limit(1);
            if (newer || dispatch.failedAt)
              return { outcome: 'accepted' as const, dispatch };
          }
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
        if (dispatch.accountingMode === 'prepaid_credit') {
          if (
            dispatch.providerMessageId &&
            dispatch.providerMessageId !== params.providerMessageId
          )
            reconciliationRequired();
          await this.accounting.prepaid.transition(
            tx,
            dispatch,
            'consume',
            params.staffAudit?.userId,
          );
        }
        const restoreReleasedUsage =
          dispatch.accountingMode !== 'prepaid_credit' &&
          dispatch.state === 'outcome_unknown' &&
          !dispatch.usageReserved &&
          dispatch.usagePeriodStart !== null;
        if (restoreReleasedUsage) {
          await this.accounting.periodic.restore(tx, dispatch, params.sentAt);
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
            usageReserved: restoreReleasedUsage ? true : dispatch.usageReserved,
            lastErrorCode: null,
            leaseUntil: null,
            updatedAt: params.sentAt,
          })
          .where(eq(verificationMessageDispatches.id, dispatch.id))
          .returning();
        if (params.staffAudit)
          await this.auditResolution(
            tx,
            dispatch,
            'accepted',
            params.staffAudit,
          );
        return { outcome: 'accepted' as const, dispatch: updated };
      },
      params.verificationId && params.kind
        ? buildDispatchKey(
            params.verificationId,
            params.kind,
            params.generation,
          )
        : undefined,
    );
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
  }): Promise<number> {
    return this.projectAcceptedVerification(
      this.db,
      { verificationId: params.verificationId, kind: params.kind },
      {
        providerMessageId: params.providerMessageId,
        sentAt: params.sentAt,
      },
    );
  }

  /** Returns how many dispatch rows were parked, so a no-op is not mistaken
   * for a successful write. */
  async markOutcomeUnknown(
    dispatchId: string,
    errorCode: string,
    providerMessageId?: string,
  ): Promise<number> {
    const rows = await this.db
      .update(verificationMessageDispatches)
      .set({
        state: 'outcome_unknown',
        ...(providerMessageId ? { providerMessageId } : {}),
        lastErrorCode: errorCode,
        leaseUntil: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(verificationMessageDispatches.id, dispatchId),
          eq(verificationMessageDispatches.state, 'sending'),
        ),
      )
      .returning({ id: verificationMessageDispatches.id });
    return rows.length;
  }

  /**
   * Records a provider call that produced no message id and refunds its usage.
   *
   * The dispatch remains `outcome_unknown` because the absence of a provider
   * id is not proof that no message was sent. Usage follows the merchant-facing
   * lifecycle, though: while the verification is failed, the reservation is
   * released. A later staff resolution as accepted restores it in
   * {@link markAccepted}.
   */
  async markFailedProviderOutcome(
    dispatchId: string,
    errorCode: string,
  ): Promise<number> {
    const now = new Date().toISOString();
    return this.withDispatchTransaction(dispatchId, async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, dispatchId))
        .for('update');
      if (!dispatch || dispatch.state !== 'sending') return 0;

      if (dispatch.accountingMode !== 'prepaid_credit')
        await this.accounting.periodic.release(tx, dispatch, now);
      const [updated] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'outcome_unknown',
          usageReserved: false,
          lastErrorCode: errorCode,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(eq(verificationMessageDispatches.id, dispatch.id))
        .returning({ id: verificationMessageDispatches.id });

      if (dispatch.kind === 'initial') {
        await tx
          .update(verifications)
          .set({
            status: statusUnlessTerminal('failed'),
            metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ reason: 'provider_outcome_unknown', kind: 'initial' })}::jsonb`,
            updatedAt: now,
          })
          .where(eq(verifications.id, dispatch.verificationId));
      } else if (dispatch.kind === 'follow_up') {
        await tx
          .update(verifications)
          .set({
            metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ follow_up_failed: 'provider_outcome_unknown', follow_up_failed_at: now })}::jsonb`,
            updatedAt: now,
          })
          .where(eq(verifications.id, dispatch.verificationId));
      }

      return updated ? 1 : 0;
    });
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
  ): Promise<
    { verificationRows: (typeof verifications.$inferSelect)[] } | undefined
  > {
    return this.withDispatchTransaction(dispatchId, async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, dispatchId))
        .for('update');
      if (!dispatch) return;
      if (dispatch.accountingMode === 'prepaid_credit') {
        // `outcome_unknown` is reachable *with* a provider message id: a send
        // whose acceptance could not be persisted is salvaged there by
        // `VerificationSendService.salvageAcceptance`, keeping the credit held
        // for staff resolution. Its receipts are real facts about a message the
        // customer received, so they must still be recorded — refusing them
        // threw out of the Meta status handler, which abandoned every remaining
        // status in the batch and made Meta retry the same payload forever.
        //
        // No credit moves on that path: nothing was consumed, so there is
        // nothing to reverse, and the hold stays until staff resolve it.
        if (
          dispatch.state !== 'accepted' &&
          dispatch.state !== 'outcome_unknown'
        )
          reconciliationRequired();
        if (status === 'failed') {
          if (dispatch.failedAt) return { verificationRows: [] };
          if (
            dispatch.readAt ||
            dispatch.deliveredAt ||
            (dispatch.acceptedAt &&
              new Date(occurredAt) < new Date(dispatch.acceptedAt))
          )
            return { verificationRows: [] };
          if (dispatch.state === 'accepted')
            await this.accounting.prepaid.transition(tx, dispatch, 'reverse');
        } else if (dispatch.failedAt) {
          return { verificationRows: [] };
        }
      }
      if (status === 'failed') {
        if (dispatch.accountingMode !== 'prepaid_credit')
          await this.accounting.periodic.release(tx, dispatch, occurredAt);
        await tx
          .update(verificationMessageDispatches)
          .set({
            failedAt: dispatch.failedAt ?? occurredAt,
            usageReserved: false,
            updatedAt: occurredAt,
          })
          .where(eq(verificationMessageDispatches.id, dispatch.id));
      } else {
        await tx
          .update(verificationMessageDispatches)
          .set({
            deliveredAt: dispatch.deliveredAt ?? occurredAt,
            ...(status === 'read'
              ? { readAt: dispatch.readAt ?? occurredAt }
              : {}),
            updatedAt: occurredAt,
          })
          .where(eq(verificationMessageDispatches.id, dispatch.id));
      }
      if (dispatch.accountingMode === 'prepaid_credit') {
        // The projection resolves against the provider message id, so a dispatch
        // parked without one has no verification row to address. The receipt is
        // still recorded above; there is simply nothing to project it onto.
        if (!dispatch.providerMessageId) return { verificationRows: [] };
        const verificationRows = await tx
          .update(verifications)
          .set({
            status:
              status === 'failed'
                ? 'failed'
                : status === 'read'
                  ? 'read'
                  : sql`CASE WHEN ${verifications.status} = 'read' THEN ${verifications.status} ELSE 'delivered'::verification_status END`,
            ...(status === 'failed'
              ? {
                  metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || '{"reason":"provider_delivery_failed"}'::jsonb`,
                }
              : status === 'read'
                ? {
                    readAt: occurredAt,
                    deliveredAt: sql`COALESCE(${verifications.deliveredAt}, ${occurredAt})`,
                  }
                : {
                    deliveredAt: sql`COALESCE(${verifications.deliveredAt}, ${occurredAt})`,
                  }),
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(verifications.id, dispatch.verificationId),
              eq(verifications.waMessageId, dispatch.providerMessageId),
              notInArray(verifications.status, [
                'confirmed',
                'canceled',
                'no_reply',
              ]),
            ),
          )
          .returning();
        return { verificationRows };
      }
    });
  }

  async isLatestGeneration(id: string): Promise<boolean> {
    const dispatch = await this.findById(id);
    if (!dispatch) return false;
    const [newer] = await this.db
      .select({ id: verificationMessageDispatches.id })
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(
            verificationMessageDispatches.verificationId,
            dispatch.verificationId,
          ),
          eq(verificationMessageDispatches.kind, dispatch.kind),
          sql`${verificationMessageDispatches.generation} > ${dispatch.generation}`,
        ),
      )
      .limit(1);
    return !newer;
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

  async resolveNotAccepted(
    id: string,
    staffAudit?: { userId: string; reason: string },
    confirmedRejection = false,
  ): Promise<DispatchRecord | undefined> {
    const now = new Date().toISOString();
    return this.withDispatchTransaction(id, async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, id))
        .for('update');
      if (!dispatch) return undefined;
      if (dispatch.state === 'rejected') return dispatch;
      if (
        dispatch.state !== 'outcome_unknown' &&
        !(confirmedRejection && dispatch.state === 'sending')
      )
        return undefined;
      if (dispatch.accountingMode === 'prepaid_credit') {
        if (dispatch.providerMessageId)
          throw new ConflictException('Provider acceptance already recorded');
        await this.accounting.prepaid.transition(
          tx,
          dispatch,
          'release',
          staffAudit?.userId,
        );
      }
      if (
        dispatch.accountingMode !== 'prepaid_credit' &&
        dispatch.usageReserved &&
        dispatch.usagePeriodStart
      ) {
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
      if (staffAudit)
        await this.auditResolution(tx, dispatch, 'not_accepted', staffAudit);
      return updated;
    });
  }

  private async claimPrepaid(
    tx: CreditTransaction,
    params: Parameters<VerificationMessageDispatchesRepository['claim']>[0],
  ): Promise<DispatchClaimResult> {
    const [linked] = await tx
      .select({ id: verifications.id })
      .from(verifications)
      .innerJoin(orders, eq(orders.id, verifications.orderId))
      .where(
        and(
          eq(verifications.id, params.verificationId),
          eq(verifications.orgId, params.orgId),
          eq(orders.orgId, params.orgId),
          eq(orders.integrationId, params.integrationId),
        ),
      );
    if (!linked) throw new ConflictException('Dispatch identity mismatch');
    const [account] = await tx
      .select({ orgId: creditAccounts.orgId })
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, params.orgId));
    if (!account)
      return { outcome: 'blocked', reason: 'STANDALONE_APPROVAL_REQUIRED' };
    await this.accounting.prepaid.lock(tx, params.orgId);
    let [dispatch] = await tx
      .select()
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.orgId, params.orgId),
          eq(
            verificationMessageDispatches.verificationId,
            params.verificationId,
          ),
          eq(verificationMessageDispatches.kind, params.kind),
        ),
      )
      .orderBy(desc(verificationMessageDispatches.generation))
      .limit(1)
      .for('update');
    if (dispatch && dispatch.integrationId !== params.integrationId)
      throw new Error('Dispatch identity mismatch');
    if (dispatch?.state === 'outcome_unknown')
      return { outcome: 'outcome_unknown', dispatch };
    if (dispatch?.state === 'accepted' && !dispatch.failedAt)
      return { outcome: 'accepted', dispatch };
    if (dispatch?.state === 'sending') {
      if (!dispatch.leaseUntil || new Date(dispatch.leaseUntil) > new Date())
        return { outcome: 'busy', dispatch };
      const [unknown] = await tx
        .update(verificationMessageDispatches)
        .set({
          state: 'outcome_unknown',
          leaseUntil: null,
          lastErrorCode: 'dispatch_lease_expired',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(verificationMessageDispatches.id, dispatch.id))
        .returning();
      return { outcome: 'outcome_unknown', dispatch: unknown };
    }
    const denial = await this.accounting.newHoldDenial(tx, params.orgId);
    if (denial) return { outcome: 'blocked', reason: denial };
    const previous = dispatch;
    if (previous && previous.state !== 'ready') {
      if (
        previous.state !== 'rejected' &&
        !(
          previous.state === 'accepted' &&
          previous.failedAt &&
          !previous.deliveredAt &&
          !previous.readAt
        )
      )
        reconciliationRequired();
      if (previous.accountingMode === 'prepaid_credit')
        await this.accounting.prepaid.assertReleased(tx, previous);
      else if (previous.usageReserved) reconciliationRequired();
    }
    const generation =
      previous && previous.state !== 'ready'
        ? previous.generation + 1
        : (previous?.generation ?? 1);
    const dispatchKey = buildDispatchKey(
      params.verificationId,
      params.kind,
      generation,
    );
    if (!previous || previous.state !== 'ready') {
      [dispatch] = await tx
        .insert(verificationMessageDispatches)
        .values({
          orgId: params.orgId,
          integrationId: params.integrationId,
          verificationId: params.verificationId,
          dispatchKey,
          generation,
          accountingMode: 'prepaid_credit',
          kind: params.kind,
          state: 'ready',
          templateName: params.templateName,
          languageCode: params.languageCode,
        })
        .returning();
    } else if (previous.accountingMode !== 'prepaid_credit') {
      if (
        previous.attemptCount ||
        previous.usageReserved ||
        previous.usagePeriodStart
      )
        reconciliationRequired();
      [dispatch] = await tx
        .update(verificationMessageDispatches)
        .set({ accountingMode: 'prepaid_credit' })
        .where(eq(verificationMessageDispatches.id, previous.id))
        .returning();
    }
    await this.accounting.prepaid.hold(tx, dispatch);
    const [claimed] = await tx
      .update(verificationMessageDispatches)
      .set({
        state: 'sending',
        templateName: params.templateName,
        languageCode: params.languageCode,
        usageReserved: false,
        usagePeriodStart: null,
        attemptCount: sql`${verificationMessageDispatches.attemptCount} + 1`,
        lastErrorCode: null,
        leaseUntil: params.leaseUntil,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(verificationMessageDispatches.id, dispatch.id))
      .returning();
    return { outcome: 'claimed', dispatch: claimed };
  }

  private withDispatchTransaction<T>(
    id: string,
    work: (tx: CreditTransaction) => Promise<T>,
    fallbackKey?: string,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      let [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, id));
      if (!dispatch && fallbackKey)
        [dispatch] = await tx
          .select()
          .from(verificationMessageDispatches)
          .where(eq(verificationMessageDispatches.dispatchKey, fallbackKey));
      if (dispatch?.accountingMode === 'prepaid_credit') {
        const [source] = await tx
          .select()
          .from(integrations)
          .where(
            and(
              eq(integrations.id, dispatch.integrationId),
              eq(integrations.orgId, dispatch.orgId),
            ),
          )
          .for('update');
        if (!source || source.platformType !== 'standalone')
          reconciliationRequired();
        await this.accounting.prepaid.lock(tx, dispatch.orgId);
      }
      return work(tx);
    });
  }

  private async auditResolution(
    tx: CreditTransaction,
    dispatch: DispatchRecord,
    resolution: 'accepted' | 'not_accepted',
    actor: { userId: string; reason: string },
  ) {
    await tx.insert(adminAccessAudit).values({
      userId: actor.userId,
      action: 'message-dispatch.resolve',
      outcome: 'allowed',
      targetIntegrationId: dispatch.integrationId,
      metadata: {
        dispatchId: dispatch.id,
        verificationId: dispatch.verificationId,
        kind: dispatch.kind,
        generation: dispatch.generation,
        resolution,
        reason: actor.reason.trim(),
      },
    });
  }

  private async projectAcceptedVerification(
    tx: DispatchWriter,
    dispatch: Pick<DispatchRecord, 'kind' | 'verificationId'>,
    params: { providerMessageId: string; sentAt: string; repair?: boolean },
  ): Promise<number> {
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
      const followUpRows = await tx
        .update(verifications)
        .set({
          ...common,
          status: sentFloor,
          followUpSentAt: params.sentAt,
          ...(params.repair
            ? {}
            : { followUpAttempts: sql`${verifications.followUpAttempts} + 1` }),
        })
        .where(
          and(
            eq(verifications.id, dispatch.verificationId),
            notInArray(verifications.status, TERMINAL_STATUSES),
          ),
        )
        .returning({ id: verifications.id });
      return followUpRows.length;
    }
    // A fresh send restarts the lifecycle, so it sets `sent` outright. A repair
    // re-states an acceptance that already happened, so it may only raise a
    // floor — walking a `delivered`/`read` row back to `sent` would replace one
    // wrong answer with another — and it must not inflate the attempt count.
    const initialRows = await tx
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
      .where(eq(verifications.id, dispatch.verificationId))
      .returning({ id: verifications.id });
    return initialRows.length;
  }
}
