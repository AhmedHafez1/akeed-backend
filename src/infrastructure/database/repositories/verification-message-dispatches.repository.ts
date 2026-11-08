import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { SelectedCodTemplate } from '../../../shared/messaging/cod-template-selector';
import {
  UNKNOWN_SENDER_OUTCOME,
  type MerchantAttemptContext,
  type SenderFailure,
  type SenderRecoveryWork,
} from '../../../shared/ports/sender-recovery.port';
import { withSerializableRetry } from '../../../shared/database/serializable-retry';
import {
  FEATURE_OFF_SENDER,
  type ResolvedSender,
} from '../../../shared/ports/sender-resolver.port';
import { acknowledgmentOptedIn } from '../../../shared/messaging/message-texts.types';
import type { CreditTransaction } from '../credit-transaction';
import { UsageAccountingRouter } from './usage-accounting.router';
import { reconciliationRequired } from './prepaid-credit-accounting';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from 'drizzle-orm';
import { usesPrepaidCredits } from '../../../shared/billing/credit-eligibility';
import {
  decidePrepaidCharge,
  nextSendDisplayedCost,
  usesCreditReservation,
  type ChargeRule,
} from '../../../shared/billing/own-number-billing.policy';
import { resolveEntitlement } from '../../../shared/billing/entitlement';
import type { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import type {
  SentTemplateIdentity,
  TemplateSendPurpose,
} from '../../../shared/messaging/cod-template-selector';
import {
  TERMINAL_STATUSES,
  WEBHOOK_PROTECTED_STATUSES,
} from '../../../shared/verification/verification-lifecycle';
import { classifyDeliveryFailure } from '../../../shared/verification/delivery-failure.policy';
import { CHANGE_REQUEST_OPEN_REASON } from '../../../shared/verification/change-request.policy';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  adminAccessAudit,
  creditAccounts,
  orders,
  integrations,
  providerMessageReceipts,
  verificationChangeRequests,
  verificationChangeRequestEffects,
  verificationMessageDispatches,
  verificationSenderAttempts,
  whatsappConnectionTemplates,
  verificationServiceMessages,
  whatsappConnections,
  verifications,
} from '../schema';
import {
  buildNoWhatsappPayload,
  buildVerificationLifecyclePayload,
} from './verifications.repository';

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

/** The staff member resolving an ambiguous send, and what they relied on. */
export interface StaffResolutionAudit {
  userId: string;
  reason: string;
  evidence?: string;
  requestId?: string;
}

export type DispatchKind =
  | 'initial'
  | 'follow_up'
  | 'acknowledgment'
  | 'change_acknowledgment';
function isServiceDispatchKind(kind: string): boolean {
  return kind === 'acknowledgment' || kind === 'change_acknowledgment';
}

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

/** What a claim records about the template it is about to send. */
export interface DispatchTemplateClaim {
  variantKey: string;
  purpose: TemplateSendPurpose;
  language: SentTemplateIdentity['language'];
  /** Why the store's stored choice was not the template sent. */
  fallbackReason?: string;
  /** The stored choice that was passed over, when there was one. */
  skippedKey?: string | null;
}

/**
 * The template columns a claim writes. `templateName` and `languageCode` are
 * the provider's name and code. The identity columns are written only when the
 * caller says which template it selected, so a row never holds a guessed one.
 */
function claimTemplateColumns(params: {
  templateName: string | null;
  languageCode: string;
  identity?: DispatchTemplateClaim;
  recipientHash?: string | null;
  changeRequestButtons?: boolean;
}) {
  return {
    templateName: params.templateName,
    languageCode: params.languageCode,
    ...(params.recipientHash !== undefined
      ? { recipientHash: params.recipientHash }
      : {}),
    ...(params.changeRequestButtons !== undefined
      ? { changeRequestButtons: params.changeRequestButtons }
      : {}),
    ...(params.identity
      ? {
          templateVariantKey: params.identity.variantKey,
          templatePurpose: params.identity.purpose,
          metaTemplateName: params.templateName,
          metaLanguageCode: params.languageCode,
          resolvedLanguage: params.identity.language,
          templateFallbackReason: params.identity.fallbackReason ?? null,
          templateSkippedKey: params.identity.fallbackReason
            ? (params.identity.skippedKey ?? null)
            : null,
        }
      : {}),
  };
}

/**
 * The confirmation cycle a new dispatch belongs to: the one its caller names
 * (an updated confirmation is claimed for the cycle it will start), else the
 * verification's current cycle, read in the claim's own statement.
 */
function claimCycleColumns(params: {
  verificationId: string;
  confirmationCycle?: number;
}) {
  return {
    confirmationCycle:
      params.confirmationCycle ??
      sql<number>`(SELECT ${verifications.confirmationCycle} FROM ${verifications} WHERE ${verifications.id} = ${params.verificationId})`,
  };
}

/** The dispatch columns restated from what the adapter reports it sent. */
function sentTemplateColumns(template: SentTemplateIdentity | undefined) {
  if (!template) return {};
  return {
    templateName: template.templateName,
    languageCode: template.languageCode,
    templateVariantKey: template.variantKey,
    metaTemplateName: template.templateName,
    metaLanguageCode: template.languageCode,
    resolvedLanguage: template.language,
  };
}

/**
 * The template a stored dispatch carried, or nothing for a row written before
 * it was recorded. Such a row is reported as "not recorded", never inferred.
 */
export function recordedDispatchTemplate(
  dispatch: Partial<
    Pick<
      DispatchRecord,
      | 'templateVariantKey'
      | 'metaTemplateName'
      | 'metaLanguageCode'
      | 'resolvedLanguage'
    >
  >,
): SentTemplateIdentity | undefined {
  if (
    !dispatch.templateVariantKey ||
    !dispatch.metaTemplateName ||
    !dispatch.metaLanguageCode ||
    !dispatch.resolvedLanguage
  )
    return undefined;
  return {
    variantKey: dispatch.templateVariantKey,
    language: dispatch.resolvedLanguage,
    templateName: dispatch.metaTemplateName,
    languageCode: dispatch.metaLanguageCode,
  };
}

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
/** A delivery receipt as the provider reported it. */
export interface ProviderReceipt {
  senderReceiptContext?: {
    phoneNumberId?: string;
    wabaId?: string;
    failure?: SenderFailure;
  };
  providerMessageId: string;
  status: 'delivered' | 'read' | 'failed';
  occurredAt: string;
  failureInfo?: { code?: number | string; title?: string };
}

/**
 * What a receipt's wamid resolved to: a ledger dispatch, a verification sent
 * before the ledger existed, or nothing yet (the receipt is parked until the
 * acceptance that records the wamid applies it).
 */
export type ReceiptResolution =
  | { outcome: 'dispatch'; dispatch: DispatchRecord }
  | { outcome: 'verification' }
  | { outcome: 'parked' };

/**
 * Verification rows a prepaid receipt projected onto; `undefined` for
 * periodic-plan dispatches, whose verification the caller projects.
 */
type ReceiptProjection =
  | { verificationRows: (typeof verifications.$inferSelect)[] }
  | undefined;

/**
 * Serializes everything that looks up or records one provider message id, so a
 * receipt and the acceptance that stores the same wamid cannot miss each other.
 */
async function lockProviderMessage(
  tx: Pick<CreditTransaction, 'execute'>,
  providerMessageId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wa-receipt:${providerMessageId}`}, 0))`,
  );
}

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
  | {
      outcome: 'claimed';
      dispatch: DispatchRecord;
      /** Present when this claim reserved a periodic-plan message. */
      usage?: {
        consumedBefore: number;
        consumedAfter: number;
        includedLimit: number;
      };
    }
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
    private readonly config?: ConfigService,
  ) {}

  async claim(params: {
    orgId: string;
    integrationId: string;
    verificationId: string;
    kind: DispatchKind;
    recipientHash?: string | null;
    changeRequestButtons?: boolean;
    changeRequestEffect?: { id: string; attempts: number };
    repliedAt?: string;
    templateName: string | null;
    languageCode: string;
    /**
     * Which template the send was selected to carry. Every send path passes
     * it; it is optional only so a caller that claims without selecting a
     * template records none.
     */
    identity?: DispatchTemplateClaim;
    sender?: ResolvedSender;
    /**
     * `fallback` charges an Akeed-number retry of a failed own-number attempt
     * with what is left instead of blocking it (D4). Absent is `standard`.
     */
    chargeRule?: ChargeRule;
    leaseUntil: string;
    /**
     * Onboarding test sends are free: the dispatch is still claimed and leased
     * like any other, but no usage is reserved and entitlement is not checked,
     * so a store without a plan (reinstall) can still see the test. The row is
     * left with `usageReserved = false` and no period, which keeps the release
     * and restore paths from ever touching usage for it.
     */
    billingExempt?: boolean;
    fallbackForDispatchId?: string;
    /**
     * The confirmation cycle the message belongs to. Absent, the
     * verification's current cycle.
     */
    confirmationCycle?: number;
  }): Promise<DispatchClaimResult> {
    const dispatchKey = buildDispatchKey(
      params.verificationId,
      params.kind,
      params.kind === 'change_acknowledgment'
        ? (params.confirmationCycle ?? 1)
        : 1,
    );
    const now = new Date().toISOString();

    const result = await this.db.transaction(async (tx) => {
      const work = async (): Promise<DispatchClaimResult> => {
        if (params.kind === 'change_acknowledgment') {
          if (!params.changeRequestEffect)
            throw new ConflictException('Change-request effect required');
          const [effect] = await tx
            .select()
            .from(verificationChangeRequestEffects)
            .where(
              and(
                eq(
                  verificationChangeRequestEffects.id,
                  params.changeRequestEffect.id,
                ),
                eq(verificationChangeRequestEffects.orgId, params.orgId),
                eq(
                  verificationChangeRequestEffects.kind,
                  'customer_acknowledgment',
                ),
              ),
            )
            .for('update');
          if (
            !effect ||
            effect.status !== 'in_progress' ||
            effect.attempts !== params.changeRequestEffect.attempts
          )
            return { outcome: 'blocked', reason: 'effect_claim_expired' };
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

        // An open change request stops the reminder. The verification is locked
        // after the source, as every writer here does, and opening a request
        // locks it too, so a request committed during this claim is seen.
        if (
          params.kind === 'follow_up' &&
          (await this.hasOpenChangeRequest(
            tx,
            params.verificationId,
            params.orgId,
          ))
        )
          return {
            outcome: 'blocked' as const,
            reason: CHANGE_REQUEST_OPEN_REASON,
          };

        if (params.fallbackForDispatchId) {
          const [verification] = await tx
            .select()
            .from(verifications)
            .where(
              and(
                eq(verifications.id, params.verificationId),
                eq(verifications.orgId, params.orgId),
              ),
            )
            .for('update');
          if (!verification || this.recoveryClosed(verification.status))
            return {
              outcome: 'blocked' as const,
              reason: 'verification_closed',
            };
          const [previous] = await tx
            .select()
            .from(verificationMessageDispatches)
            .where(
              and(
                eq(
                  verificationMessageDispatches.id,
                  params.fallbackForDispatchId,
                ),
                eq(verificationMessageDispatches.orgId, params.orgId),
              ),
            )
            .for('update');
          if (
            !previous ||
            previous.verificationId !== params.verificationId ||
            previous.kind !== params.kind ||
            previous.senderKind !== 'merchant_own' ||
            previous.senderRecoveryState !== 'fallback' ||
            params.sender?.kind !== 'akeed_system' ||
            params.chargeRule !== 'fallback'
          )
            return {
              outcome: 'blocked' as const,
              reason: 'sender_fallback_not_authorized',
            };
          const [successor] = await tx
            .select()
            .from(verificationMessageDispatches)
            .where(
              eq(
                verificationMessageDispatches.fallbackForDispatchId,
                previous.id,
              ),
            );
          if (successor) {
            if (successor.state === 'rejected' || successor.failedAt)
              return {
                outcome: 'blocked' as const,
                reason: 'sender_fallback_failed',
              };
            if (
              successor.state === 'sending' &&
              successor.leaseUntil &&
              new Date(successor.leaseUntil) < new Date()
            ) {
              const [unknown] = await tx
                .update(verificationMessageDispatches)
                .set({
                  state: 'outcome_unknown',
                  leaseUntil: null,
                  lastErrorCode: 'dispatch_lease_expired',
                })
                .where(eq(verificationMessageDispatches.id, successor.id))
                .returning();
              return { outcome: 'outcome_unknown' as const, dispatch: unknown };
            }
            return {
              outcome:
                successor.state === 'accepted'
                  ? ('accepted' as const)
                  : successor.state === 'outcome_unknown'
                    ? ('outcome_unknown' as const)
                    : ('busy' as const),
              dispatch: successor,
            };
          }
          if (
            previous.usageReserved ||
            (previous.accountingMode === 'prepaid_credit' &&
              previous.billingCost &&
              !previous.billingRefundedAt)
          )
            reconciliationRequired();
          if (previous.accountingMode === 'prepaid_credit')
            return this.claimPrepaid(tx, params);
          const [fresh] = await tx
            .insert(verificationMessageDispatches)
            .values({
              orgId: params.orgId,
              integrationId: params.integrationId,
              verificationId: params.verificationId,
              kind: params.kind,
              generation: previous.generation + 1,
              dispatchKey: buildDispatchKey(
                params.verificationId,
                params.kind,
                previous.generation + 1,
              ),
              fallbackForDispatchId: previous.id,
              ...claimTemplateColumns(params),
              ...claimCycleColumns(params),
              changeRequestButtons: params.changeRequestButtons ?? false,
              recipientHash: params.recipientHash,
            })
            .returning();
          const entitlement = resolveEntitlement(source, {
            id: params.integrationId,
            orgId: params.orgId,
          });
          if (!params.billingExempt && !entitlement.allowed)
            throw new ConflictException('Fallback integration is not eligible');
          const senderColumns = await this.claimSenderColumns(
            tx,
            params,
            fresh,
          );
          const reservation = params.billingExempt
            ? null
            : await this.accounting.periodic.reserve(
                tx,
                {
                  ...params,
                  id: params.integrationId,
                  senderKind: 'akeed_system',
                  chargeRule: 'fallback',
                },
                entitlement,
                now,
              );
          if (reservation && !reservation.allowed)
            throw new ConflictException('Fallback accounting refused');
          const [claimed] = await tx
            .update(verificationMessageDispatches)
            .set({
              state: 'sending',
              ...senderColumns,
              leaseUntil: params.leaseUntil,
              attemptCount: 1,
              usageReserved: !params.billingExempt,
              usagePeriodStart: params.billingExempt
                ? null
                : entitlement.periodStart,
              billingPool: reservation?.allowed ? reservation.pool : null,
              billingCost: reservation?.allowed ? reservation.cost : null,
              metadata: params.billingExempt ? { billingExempt: true } : {},
              updatedAt: now,
            })
            .where(eq(verificationMessageDispatches.id, fresh.id))
            .returning();
          return { outcome: 'claimed' as const, dispatch: claimed };
        }

        if (
          params.kind === 'acknowledgment' &&
          (!source?.isActive ||
            !params.repliedAt ||
            !acknowledgmentOptedIn(
              source.acknowledgmentEnabled,
              source.acknowledgmentEnabledAt,
              params.repliedAt,
            ))
        ) {
          return {
            outcome: 'blocked' as const,
            reason: 'acknowledgment_disabled',
          };
        }

        if (
          source &&
          !params.billingExempt &&
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
            generation:
              params.kind === 'change_acknowledgment'
                ? (params.confirmationCycle ?? 1)
                : 1,
            kind: params.kind,
            state: 'ready',
            ...claimTemplateColumns(params),
            ...claimCycleColumns(params),
            changeRequestButtons: params.changeRequestButtons ?? false,
            recipientHash: params.recipientHash,
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
          if (
            dispatch.senderKind === 'merchant_own' &&
            dispatch.billingRefundedAt
          )
            return { outcome: 'busy' as const, dispatch };
          return { outcome: 'accepted' as const, dispatch };
        }
        if (
          dispatch.senderKind === 'merchant_own' &&
          !isServiceDispatchKind(dispatch.kind) &&
          ((dispatch.state === 'outcome_unknown' &&
            !dispatch.providerMessageId) ||
            (dispatch.state === 'sending' &&
              dispatch.leaseUntil &&
              new Date(dispatch.leaseUntil) < new Date()))
        ) {
          const [attempt] = await tx
            .select()
            .from(verificationSenderAttempts)
            .where(
              and(
                eq(verificationSenderAttempts.dispatchId, dispatch.id),
                eq(verificationSenderAttempts.orgId, dispatch.orgId),
              ),
            )
            .orderBy(desc(verificationSenderAttempts.attemptNumber))
            .limit(1);
          await this.merchantFailure(
            tx,
            dispatch,
            attempt,
            UNKNOWN_SENDER_OUTCOME,
            now,
          );
          return { outcome: 'busy' as const, dispatch };
        }
        if (dispatch.state === 'outcome_unknown') {
          return { outcome: 'outcome_unknown' as const, dispatch };
        }
        if (
          dispatch.senderKind === 'merchant_own' &&
          dispatch.senderRecoveryState &&
          dispatch.senderRecoveryState !== 'complete'
        )
          return { outcome: 'busy' as const, dispatch };
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
          if (
            isServiceDispatchKind(dispatch.kind) ||
            dispatch.attemptCount >= MAX_LEASE_RECLAIM_ATTEMPTS
          ) {
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

        if (isServiceDispatchKind(dispatch.kind) && dispatch.attemptCount > 0)
          return { outcome: 'busy' as const, dispatch };

        if (params.billingExempt) {
          if (!source?.isActive)
            return {
              outcome: 'blocked' as const,
              reason: 'integration_inactive',
            };
          const [claimedExempt] = await tx
            .update(verificationMessageDispatches)
            .set({
              state: 'sending',
              ...(await this.claimSenderColumns(tx, params, dispatch)),
              ...claimTemplateColumns(params),
              attemptCount: sql`${verificationMessageDispatches.attemptCount} + 1`,
              lastErrorCode: reclaimedFromExpiredLease
                ? 'dispatch_lease_expired'
                : null,
              leaseUntil: params.leaseUntil,
              metadata: sql`${verificationMessageDispatches.metadata} || '{"billingExempt":true}'::jsonb`,
              updatedAt: now,
            })
            .where(eq(verificationMessageDispatches.id, dispatch.id))
            .returning();
          return { outcome: 'claimed' as const, dispatch: claimedExempt };
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

        let usage:
          | {
              consumedBefore: number;
              consumedAfter: number;
              includedLimit: number;
            }
          | undefined;
        // The sender decides the pool, so it is settled before usage is taken.
        const senderColumns = await this.claimSenderColumns(
          tx,
          params,
          dispatch,
        );
        let billing: {
          billingPool?: 'akeed' | 'own_number';
          billingCost?: number;
        } = {};
        if (!dispatch.usageReserved) {
          const reservation = await this.accounting.periodic.reserve(
            tx,
            {
              ...params,
              id: params.integrationId,
              senderKind: senderColumns.senderKind ?? dispatch.senderKind,
              chargeRule: params.chargeRule,
            },
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
          usage = {
            consumedBefore: reservation.consumedBefore,
            consumedAfter: reservation.consumedAfter,
            includedLimit: reservation.includedLimit,
          };
          billing = {
            billingPool: reservation.pool,
            billingCost: reservation.cost,
          };
        }

        const [claimed] = await tx
          .update(verificationMessageDispatches)
          .set({
            state: 'sending',
            ...senderColumns,
            ...billing,
            ...claimTemplateColumns(params),
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
        return { outcome: 'claimed' as const, dispatch: claimed, usage };
      };
      const result = await work();
      if (
        params.kind === 'change_acknowledgment' &&
        result.outcome === 'blocked' &&
        params.changeRequestEffect
      ) {
        await tx
          .update(verificationChangeRequestEffects)
          .set({
            status: 'skipped',
            reason: ['INSUFFICIENT_CREDITS', 'plan_limit_reached'].includes(
              result.reason,
            )
              ? 'skipped_no_allowance'
              : result.reason.slice(0, 64),
            completedAt: new Date().toISOString(),
            leaseUntil: null,
          })
          .where(
            and(
              eq(
                verificationChangeRequestEffects.id,
                params.changeRequestEffect.id,
              ),
              eq(verificationChangeRequestEffects.orgId, params.orgId),
              eq(
                verificationChangeRequestEffects.attempts,
                params.changeRequestEffect.attempts,
              ),
              eq(verificationChangeRequestEffects.status, 'in_progress'),
            ),
          );
      }
      return result;
    });
    return result;
  }

  /**
   * Settles a prepaid dispatch by what its claim charged, never by its sender.
   * A reservation settles as it always has. An own-number charge was taken at
   * claim time, so acceptance has nothing to do and a release or reversal
   * returns the credit once.
   */
  private async settlePrepaid(
    tx: CreditTransaction,
    dispatch: DispatchRecord,
    action: 'consume' | 'release' | 'reverse',
    occurredAt: string,
    actorId?: string,
  ): Promise<void> {
    if (usesCreditReservation(dispatch)) {
      await this.accounting.prepaid.transition(tx, dispatch, action, actorId);
      return;
    }
    if (action !== 'consume')
      await this.accounting.prepaid.refundSpare(tx, dispatch, occurredAt);
  }

  /** The sender a claim will record, for the charge decided before it. */
  private claimedSenderKind(
    params: Parameters<VerificationMessageDispatchesRepository['claim']>[0],
    dispatch: DispatchRecord | undefined,
  ): DispatchRecord['senderKind'] {
    if (dispatch && dispatch.attemptCount > 0)
      return dispatch.senderReason ? dispatch.senderKind : 'akeed_system';
    return params.sender?.kind ?? 'akeed_system';
  }

  /** Sender metadata is immutable once an attempt has begun. */
  private async claimSenderColumns(
    tx: CreditTransaction,
    params: Parameters<VerificationMessageDispatchesRepository['claim']>[0],
    dispatch: DispatchRecord,
  ): Promise<
    Partial<
      Pick<
        DispatchRecord,
        | 'senderKind'
        | 'senderConnectionId'
        | 'senderPhoneNumberId'
        | 'senderReason'
        | 'senderConnectionGeneration'
      >
    >
  > {
    if (dispatch.attemptCount > 0 && dispatch.senderReason) return {};
    const sender =
      dispatch.attemptCount > 0
        ? FEATURE_OFF_SENDER
        : (params.sender ??
          (params.kind === 'acknowledgment'
            ? { ...FEATURE_OFF_SENDER, reason: 'service_message' }
            : FEATURE_OFF_SENDER));
    let phoneNumberId = this.config?.get<string>('WA_PHONE_NUMBER_ID') ?? null;
    if (sender.kind === 'merchant_own') {
      if (!sender.connectionId) throw new Error('Sender connection missing');
      const [connection] = await tx
        .select({
          phoneNumberId: whatsappConnections.phoneNumberId,
          signupGeneration: whatsappConnections.signupGeneration,
        })
        .from(whatsappConnections)
        .where(
          and(
            eq(whatsappConnections.id, sender.connectionId),
            eq(whatsappConnections.orgId, params.orgId),
            eq(whatsappConnections.state, 'active'),
            isNull(whatsappConnections.degradedClass),
          ),
        )
        .limit(1);
      if (!connection) throw new Error('Sender connection unavailable');
      phoneNumberId = connection.phoneNumberId;
      return {
        senderKind: sender.kind,
        senderConnectionId: sender.connectionId,
        senderPhoneNumberId: phoneNumberId,
        senderReason: sender.reason,
        senderConnectionGeneration: connection.signupGeneration,
      };
    }
    return {
      senderKind: sender.kind,
      senderConnectionId: sender.connectionId,
      senderPhoneNumberId: phoneNumberId,
      senderReason: sender.reason,
    };
  }

  private async hasOpenChangeRequest(
    tx: CreditTransaction,
    verificationId: string,
    orgId: string,
  ): Promise<boolean> {
    const [locked] = await tx
      .select({ id: verifications.id })
      .from(verifications)
      .where(
        and(
          eq(verifications.id, verificationId),
          eq(verifications.orgId, orgId),
        ),
      )
      .for('update');
    if (!locked) return false;
    const [open] = await tx
      .select({ id: verificationChangeRequests.id })
      .from(verificationChangeRequests)
      .where(
        and(
          eq(verificationChangeRequests.verificationId, verificationId),
          eq(verificationChangeRequests.status, 'open'),
        ),
      )
      .limit(1);
    return Boolean(open);
  }

  private recoveryClosed(status: string | null): boolean {
    return [
      'confirmed',
      'canceled',
      'expired',
      'no_reply',
      'no_whatsapp',
      'blocked',
    ].includes(status ?? '');
  }

  async hasSenderRecovery(
    verificationId: string,
    orgId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: verificationMessageDispatches.id })
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.verificationId, verificationId),
          eq(verificationMessageDispatches.orgId, orgId),
          sql`(${verificationMessageDispatches.senderRecoveryState} IN ('retry', 'fallback') OR ${verificationMessageDispatches.senderAutomationPending})`,
        ),
      )
      .limit(1);
    return !!row;
  }

  private async refundMerchant(
    tx: CreditTransaction,
    dispatch: DispatchRecord,
    now: string,
  ) {
    if (dispatch.billingRefundedAt) return;
    if (dispatch.accountingMode === 'prepaid_credit')
      await this.settlePrepaid(tx, dispatch, 'release', now);
    else await this.accounting.periodic.release(tx, dispatch, now);
    await tx
      .update(verificationMessageDispatches)
      .set({ usageReserved: false, billingRefundedAt: now })
      .where(eq(verificationMessageDispatches.id, dispatch.id));
  }

  async beginMerchantAttempt(
    orgId: string,
    dispatchId: string,
    template: SelectedCodTemplate,
    retry = false,
  ) {
    return withSerializableRetry(() =>
      this.withDispatchTransaction(dispatchId, async (tx) => {
        const [verification] = await tx
          .select()
          .from(verifications)
          .where(
            and(
              eq(verifications.orgId, orgId),
              sql`${verifications.id} = (SELECT verification_id FROM verification_message_dispatches WHERE id = ${dispatchId} AND org_id = ${orgId})`,
            ),
          )
          .for('update');
        const [dispatch] = await tx
          .select()
          .from(verificationMessageDispatches)
          .where(
            and(
              eq(verificationMessageDispatches.id, dispatchId),
              eq(verificationMessageDispatches.orgId, orgId),
            ),
          )
          .for('update');
        if (!dispatch || dispatch.senderKind !== 'merchant_own') return null;
        if (!verification || this.recoveryClosed(verification.status)) {
          if (
            dispatch.senderRecoveryState === 'retry' ||
            dispatch.state === 'sending'
          ) {
            await this.refundMerchant(tx, dispatch, new Date().toISOString());
            await tx
              .update(verificationMessageDispatches)
              .set({
                state: 'rejected',
                senderRecoveryState: 'canceled',
                senderRecoveryDueAt: null,
                leaseUntil: null,
              })
              .where(eq(verificationMessageDispatches.id, dispatchId));
          }
          return null;
        }
        if (
          retry &&
          (dispatch.senderRecoveryState !== 'retry' ||
            !dispatch.senderRecoveryDueAt ||
            new Date(dispatch.senderRecoveryDueAt) > new Date() ||
            dispatch.senderRetryCount >= 2)
        )
          return null;
        if (!retry && dispatch.state !== 'sending') return null;
        const number = dispatch.senderRetryCount + (retry ? 1 : 0);
        const [existing] = await tx
          .select()
          .from(verificationSenderAttempts)
          .where(
            and(
              eq(verificationSenderAttempts.dispatchId, dispatchId),
              eq(verificationSenderAttempts.attemptNumber, number),
            ),
          );
        if (existing) return null;
        const [connection] = await tx
          .select()
          .from(whatsappConnections)
          .where(
            and(
              eq(whatsappConnections.id, dispatch.senderConnectionId!),
              eq(whatsappConnections.orgId, orgId),
            ),
          );
        if (!connection)
          throw new ConflictException('Sender connection missing');
        const claimToken = randomUUID();
        const leaseUntil = new Date(Date.now() + 60_000).toISOString();
        const [attempt] = await tx
          .insert(verificationSenderAttempts)
          .values({
            orgId,
            dispatchId,
            attemptNumber: number,
            claimToken,
            state: 'authorized',
            connectionId: connection.id,
            signupGeneration:
              dispatch.senderConnectionGeneration ??
              connection.signupGeneration,
            phoneNumberId: dispatch.senderPhoneNumberId!,
            wabaId: connection.wabaId,
            leaseUntil,
          })
          .returning();
        await tx
          .update(verificationMessageDispatches)
          .set({
            state: 'sending',
            senderRecoveryState: retry ? 'retry' : null,
            senderRecoveryDueAt: null,
            senderRetryCount: number,
            senderRecoveryTemplate: { ...template, imageHeader: undefined },
            providerMessageId: null,
            acceptedAt: null,
            failedAt: null,
            leaseUntil,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(verificationMessageDispatches.id, dispatchId));
        return { attemptId: attempt.id, claimToken };
      }),
    );
  }

  /** Consumes authorization once, immediately before the adapter calls HTTP. */
  async authorizeMerchantAttempt(
    orgId: string,
    dispatchId: string,
    context: MerchantAttemptContext,
  ): Promise<boolean> {
    const rows = await this.db
      .update(verificationSenderAttempts)
      .set({ state: 'in_flight' })
      .where(
        and(
          eq(verificationSenderAttempts.id, context.attemptId),
          eq(verificationSenderAttempts.orgId, orgId),
          eq(verificationSenderAttempts.dispatchId, dispatchId),
          eq(verificationSenderAttempts.claimToken, context.claimToken),
          eq(verificationSenderAttempts.state, 'authorized'),
          sql`${verificationSenderAttempts.leaseUntil} > now()`,
          sql`EXISTS (SELECT 1 FROM verification_message_dispatches d JOIN verifications v ON v.id = d.verification_id AND v.org_id = d.org_id JOIN whatsapp_connections c ON c.id = d.sender_connection_id AND c.org_id = d.org_id WHERE d.id = ${dispatchId} AND d.sender_retry_count = ${verificationSenderAttempts.attemptNumber} AND d.state = 'sending' AND c.signup_generation = ${verificationSenderAttempts.signupGeneration} AND c.state = 'active' AND v.status NOT IN ('confirmed','canceled','expired','no_reply','no_whatsapp','blocked'))`,
        ),
      )
      .returning({ id: verificationSenderAttempts.id });
    return rows.length === 1;
  }

  private async merchantFailure(
    tx: CreditTransaction,
    dispatch: DispatchRecord,
    attempt: typeof verificationSenderAttempts.$inferSelect | undefined,
    failure: SenderFailure,
    now: string,
  ) {
    if (attempt)
      await tx
        .update(verificationSenderAttempts)
        .set({
          state: failure.class === 'outcome_unknown' ? 'unknown' : 'failed',
          failedAt: failure.class === 'outcome_unknown' ? null : now,
          failure,
        })
        .where(eq(verificationSenderAttempts.id, attempt.id));
    const [verification] = await tx
      .select()
      .from(verifications)
      .where(
        and(
          eq(verifications.id, dispatch.verificationId),
          eq(verifications.orgId, dispatch.orgId),
        ),
      );
    const closed = !verification || this.recoveryClosed(verification.status);
    const action = closed
      ? 'canceled'
      : failure.action === 'retry' && dispatch.senderRetryCount < 2
        ? 'retry'
        : failure.action === 'fail'
          ? 'complete'
          : 'fallback';
    const dueAt =
      action === 'retry'
        ? new Date(
            Date.now() + (dispatch.senderRetryCount === 0 ? 30_000 : 120_000),
          ).toISOString()
        : action === 'fallback'
          ? now
          : null;
    if (action !== 'retry') await this.refundMerchant(tx, dispatch, now);
    await tx
      .update(verificationMessageDispatches)
      .set({
        state:
          action === 'retry'
            ? 'sending'
            : dispatch.providerMessageId
              ? 'accepted'
              : 'rejected',
        failedAt: now,
        resolvedAt: action === 'retry' ? null : now,
        lastErrorCode: failure.code ?? 'outcome_unknown',
        senderRecoveryState: action,
        senderRecoveryVersion: sql`${verificationMessageDispatches.senderRecoveryVersion} + 1`,
        senderRecoveryDueAt: dueAt,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(eq(verificationMessageDispatches.id, dispatch.id));
    if (action === 'complete' && !closed)
      await tx
        .update(verifications)
        .set(
          failure.code === '131026'
            ? buildNoWhatsappPayload(now, { code: failure.code })
            : { status: 'failed', updatedAt: now },
        )
        .where(
          and(
            eq(verifications.id, dispatch.verificationId),
            eq(verifications.orgId, dispatch.orgId),
            notInArray(verifications.status, WEBHOOK_PROTECTED_STATUSES),
          ),
        );
    if (failure.degrade)
      await tx
        .update(whatsappConnections)
        .set({
          degradedClass: sql`CASE WHEN ${whatsappConnections.degradedClass} = 'credentials' THEN 'credentials' ELSE ${failure.degrade} END`,
          degradedSince: sql`COALESCE(${whatsappConnections.degradedSince}, now())`,
          healthRevision: sql`${whatsappConnections.healthRevision} + 1`,
          nextHealthAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(whatsappConnections.id, dispatch.senderConnectionId!),
            eq(whatsappConnections.orgId, dispatch.orgId),
            eq(
              whatsappConnections.signupGeneration,
              dispatch.senderConnectionGeneration ??
                attempt?.signupGeneration ??
                0,
            ),
            sql`${whatsappConnections.state} IN ('active', 'verifying')`,
          ),
        );
    if (failure.templateStatus && dispatch.senderRecoveryTemplate?.registryKey)
      await tx
        .update(whatsappConnectionTemplates)
        .set({
          status: failure.templateStatus,
          lastErrorCode: failure.code,
          lastError: null,
          statusEventAt: now,
        })
        .where(
          and(
            eq(whatsappConnectionTemplates.orgId, dispatch.orgId),
            eq(
              whatsappConnectionTemplates.connectionId,
              dispatch.senderConnectionId!,
            ),
            sql`${whatsappConnectionTemplates.templateId} IN (SELECT id FROM whatsapp_templates WHERE key = ${dispatch.senderRecoveryTemplate.registryKey} AND meta_template_name = ${dispatch.templateName} AND meta_language_code = ${dispatch.languageCode})`,
            sql`EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = ${dispatch.senderConnectionId} AND c.org_id = ${dispatch.orgId} AND c.signup_generation = ${dispatch.senderConnectionGeneration ?? attempt?.signupGeneration ?? 0})`,
          ),
        );
  }

  async failMerchantAttempt(
    orgId: string,
    dispatchId: string,
    context: MerchantAttemptContext | null,
    failure: SenderFailure,
  ) {
    await withSerializableRetry(() =>
      this.withDispatchTransaction(dispatchId, async (tx) => {
        await tx
          .select()
          .from(verifications)
          .where(
            and(
              eq(verifications.orgId, orgId),
              sql`${verifications.id} = (SELECT verification_id FROM verification_message_dispatches WHERE id = ${dispatchId})`,
            ),
          )
          .for('update');
        const [dispatch] = await tx
          .select()
          .from(verificationMessageDispatches)
          .where(
            and(
              eq(verificationMessageDispatches.id, dispatchId),
              eq(verificationMessageDispatches.orgId, orgId),
            ),
          )
          .for('update');
        if (!dispatch || dispatch.senderKind !== 'merchant_own') return;
        const [attempt] = context
          ? await tx
              .select()
              .from(verificationSenderAttempts)
              .where(
                and(
                  eq(verificationSenderAttempts.id, context.attemptId),
                  eq(verificationSenderAttempts.claimToken, context.claimToken),
                  eq(verificationSenderAttempts.dispatchId, dispatchId),
                  eq(verificationSenderAttempts.orgId, orgId),
                ),
              )
              .for('update')
          : await tx
              .select()
              .from(verificationSenderAttempts)
              .where(
                and(
                  eq(verificationSenderAttempts.dispatchId, dispatchId),
                  eq(verificationSenderAttempts.orgId, orgId),
                ),
              )
              .orderBy(desc(verificationSenderAttempts.attemptNumber))
              .limit(1)
              .for('update');
        if (
          context &&
          (!attempt || !['authorized', 'in_flight'].includes(attempt.state))
        )
          return;
        if (attempt && attempt.attemptNumber !== dispatch.senderRetryCount)
          return;
        if (
          ['complete', 'canceled', 'fallback'].includes(
            dispatch.senderRecoveryState ?? '',
          )
        )
          return;
        await this.merchantFailure(
          tx,
          dispatch,
          attempt,
          failure,
          new Date().toISOString(),
        );
      }),
    );
  }

  async acceptMerchantAttempt(
    orgId: string,
    dispatchId: string,
    context: MerchantAttemptContext,
    providerMessageId: string,
    sentAt: string,
  ): Promise<boolean> {
    const accepted = await withSerializableRetry(() =>
      this.withDispatchTransaction(dispatchId, async (tx) => {
        await tx
          .select()
          .from(verifications)
          .where(
            and(
              eq(verifications.orgId, orgId),
              sql`${verifications.id} = (SELECT verification_id FROM verification_message_dispatches WHERE id = ${dispatchId})`,
            ),
          )
          .for('update');
        const [dispatch] = await tx
          .select()
          .from(verificationMessageDispatches)
          .where(
            and(
              eq(verificationMessageDispatches.id, dispatchId),
              eq(verificationMessageDispatches.orgId, orgId),
            ),
          )
          .for('update');
        const [attempt] = await tx
          .select()
          .from(verificationSenderAttempts)
          .where(
            and(
              eq(verificationSenderAttempts.id, context.attemptId),
              eq(verificationSenderAttempts.claimToken, context.claimToken),
              eq(verificationSenderAttempts.orgId, orgId),
              eq(verificationSenderAttempts.dispatchId, dispatchId),
            ),
          )
          .for('update');
        if (!dispatch || !attempt) return false;
        if (
          attempt.providerMessageId &&
          attempt.providerMessageId !== providerMessageId
        )
          throw new ConflictException('Merchant attempt acceptance conflict');
        await tx
          .update(verificationSenderAttempts)
          .set({
            providerMessageId,
            acceptedAt: attempt.acceptedAt ?? sentAt,
            ...(!attempt.failedAt ? { state: 'accepted' as const } : {}),
          })
          .where(eq(verificationSenderAttempts.id, attempt.id));
        if (
          attempt.failedAt ||
          attempt.attemptNumber !== dispatch.senderRetryCount ||
          ['fallback', 'canceled'].includes(dispatch.senderRecoveryState ?? '')
        )
          return false;
        if (
          dispatch.state === 'accepted' &&
          dispatch.senderRecoveryState === 'complete' &&
          dispatch.providerMessageId === providerMessageId
        )
          return true;
        await this.projectAcceptedVerification(tx, dispatch, {
          providerMessageId,
          sentAt,
          template: recordedDispatchTemplate(dispatch),
        });
        await tx
          .update(verificationMessageDispatches)
          .set({
            state: 'accepted',
            providerMessageId,
            acceptedAt: sentAt,
            leaseUntil: null,
            senderRecoveryState: 'complete',
            senderRecoveryDueAt: dispatch.senderRetryCount > 0 ? sentAt : null,
            senderAutomationPending: dispatch.senderRetryCount > 0,
            lastErrorCode: null,
            updatedAt: sentAt,
          })
          .where(eq(verificationMessageDispatches.id, dispatchId));
        return true;
      }),
    );
    await this.drainMerchantReceipts(providerMessageId);
    const current = await this.findSenderRecovery(orgId, dispatchId);
    return accepted && current?.senderRecoveryState === 'complete';
  }

  private async drainMerchantReceipts(providerMessageId: string) {
    const receipts = await this.db
      .select()
      .from(providerMessageReceipts)
      .where(
        and(
          eq(providerMessageReceipts.providerMessageId, providerMessageId),
          isNull(providerMessageReceipts.appliedAt),
          isNotNull(providerMessageReceipts.senderReceiptContext),
        ),
      )
      .orderBy(providerMessageReceipts.occurredAt)
      .limit(100);
    for (const receipt of receipts) {
      const applied = await this.recordMerchantReceipt({
        providerMessageId,
        status: receipt.status,
        occurredAt: receipt.occurredAt,
        ...receipt.senderReceiptContext,
      });
      if (applied)
        await this.db
          .update(providerMessageReceipts)
          .set({ appliedAt: new Date().toISOString() })
          .where(eq(providerMessageReceipts.id, receipt.id));
    }
  }

  async findSenderRecovery(orgId: string, dispatchId: string) {
    const [row] = await this.db
      .select()
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.id, dispatchId),
          eq(verificationMessageDispatches.orgId, orgId),
        ),
      );
    return row ?? null;
  }

  async senderFailureEvent(orgId: string, dispatchId: string) {
    const [row] = await this.db
      .select({
        failure: verificationSenderAttempts.failure,
        connectionId: verificationSenderAttempts.connectionId,
        signupGeneration: verificationSenderAttempts.signupGeneration,
        version: verificationMessageDispatches.senderRecoveryVersion,
      })
      .from(verificationSenderAttempts)
      .innerJoin(
        verificationMessageDispatches,
        eq(
          verificationMessageDispatches.id,
          verificationSenderAttempts.dispatchId,
        ),
      )
      .where(
        and(
          eq(verificationSenderAttempts.orgId, orgId),
          eq(verificationMessageDispatches.orgId, orgId),
          eq(verificationSenderAttempts.dispatchId, dispatchId),
        ),
      )
      .orderBy(desc(verificationSenderAttempts.attemptNumber))
      .limit(1);
    if (
      !row?.failure ||
      (!row.failure.degrade && row.failure.class !== 'template')
    )
      return null;
    return {
      orgId,
      connectionId: row.connectionId,
      signupGeneration: row.signupGeneration,
      kind:
        row.failure.class === 'template'
          ? ('template_failed' as const)
          : ('degraded' as const),
      failureClass: row.failure.class,
      dedupeKey: `dispatch:${dispatchId}:${row.version}`,
    };
  }

  async acknowledgeRecoveryAutomation(orgId: string, dispatchId: string) {
    await this.db
      .update(verificationMessageDispatches)
      .set({ senderAutomationPending: false, senderRecoveryDueAt: null })
      .where(
        and(
          eq(verificationMessageDispatches.id, dispatchId),
          eq(verificationMessageDispatches.orgId, orgId),
          eq(verificationMessageDispatches.senderRecoveryState, 'complete'),
        ),
      );
  }

  async recoveryAcceptance(orgId: string, dispatchId: string) {
    const [row] = await this.db
      .select()
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.orgId, orgId),
          sql`(${verificationMessageDispatches.id} = ${dispatchId} OR ${verificationMessageDispatches.fallbackForDispatchId} = ${dispatchId})`,
          eq(verificationMessageDispatches.state, 'accepted'),
          isNull(verificationMessageDispatches.failedAt),
        ),
      )
      .orderBy(desc(verificationMessageDispatches.generation))
      .limit(1);
    return row ?? null;
  }

  async finishSenderRecovery(
    orgId: string,
    dispatchId: string,
    canceled = false,
    scheduleAutomation = false,
  ) {
    await withSerializableRetry(() =>
      this.withDispatchTransaction(dispatchId, async (tx) => {
        const [dispatch] = await tx
          .select()
          .from(verificationMessageDispatches)
          .where(
            and(
              eq(verificationMessageDispatches.id, dispatchId),
              eq(verificationMessageDispatches.orgId, orgId),
            ),
          )
          .for('update');
        if (
          !dispatch ||
          !['retry', 'fallback'].includes(dispatch.senderRecoveryState ?? '')
        )
          return;
        if (canceled)
          await this.refundMerchant(tx, dispatch, new Date().toISOString());
        await tx
          .update(verificationMessageDispatches)
          .set({
            senderRecoveryState: canceled ? 'canceled' : 'complete',
            senderRecoveryDueAt: scheduleAutomation
              ? new Date().toISOString()
              : null,
            senderAutomationPending: scheduleAutomation,
            ...(canceled
              ? {
                  state: dispatch.providerMessageId
                    ? ('accepted' as const)
                    : ('rejected' as const),
                  leaseUntil: null,
                  failedAt: new Date().toISOString(),
                }
              : {}),
          })
          .where(eq(verificationMessageDispatches.id, dispatchId));
      }),
    );
  }

  /** Merchant receipts never enter the shared-sender projection path. */
  async recordMerchantReceipt(input: {
    providerMessageId: string;
    attemptId?: string;
    phoneNumberId?: string;
    wabaId?: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    occurredAt: string;
    failure?: SenderFailure;
  }): Promise<{
    dispatchId: string;
    orgId: string;
    verificationId: string;
  } | null> {
    const callbackId =
      input.attemptId && /^[0-9a-f-]{36}$/i.test(input.attemptId)
        ? input.attemptId
        : null;
    const [found] = await this.db
      .select()
      .from(verificationSenderAttempts)
      .where(
        callbackId
          ? eq(verificationSenderAttempts.id, callbackId)
          : eq(
              verificationSenderAttempts.providerMessageId,
              input.providerMessageId,
            ),
      )
      .limit(1);
    if (!found) return null;
    const identity = { dispatchId: found.dispatchId, orgId: found.orgId };
    // A known merchant receipt with invalid routing evidence is consumed, not
    // handed to the legacy unscoped projection.
    const [root] = await this.db
      .select({ verificationId: verificationMessageDispatches.verificationId })
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.id, found.dispatchId),
          eq(verificationMessageDispatches.orgId, found.orgId),
        ),
      );
    if (!root) return null;
    const result = { ...identity, verificationId: root.verificationId };
    if (
      !input.phoneNumberId ||
      input.phoneNumberId !== found.phoneNumberId ||
      !input.wabaId ||
      input.wabaId !== found.wabaId ||
      (found.providerMessageId &&
        found.providerMessageId !== input.providerMessageId)
    )
      return result;
    await withSerializableRetry(() =>
      this.withDispatchTransaction(found.dispatchId, async (tx) => {
        await tx
          .select()
          .from(verifications)
          .where(
            and(
              eq(verifications.id, root.verificationId),
              eq(verifications.orgId, found.orgId),
            ),
          )
          .for('update');
        const [dispatch] = await tx
          .select()
          .from(verificationMessageDispatches)
          .where(
            and(
              eq(verificationMessageDispatches.id, found.dispatchId),
              eq(verificationMessageDispatches.orgId, found.orgId),
            ),
          )
          .for('update');
        const [attempt] = await tx
          .select()
          .from(verificationSenderAttempts)
          .where(eq(verificationSenderAttempts.id, found.id))
          .for('update');
        if (!dispatch || !attempt) return;
        const now = input.occurredAt;
        const current =
          dispatch.senderRetryCount === attempt.attemptNumber &&
          !['fallback', 'canceled'].includes(
            dispatch.senderRecoveryState ?? '',
          ) &&
          !dispatch.billingRefundedAt;
        if (input.status === 'failed') {
          if (attempt.failedAt || attempt.deliveredAt || attempt.readAt) return;
          await tx
            .update(verificationSenderAttempts)
            .set({
              providerMessageId: input.providerMessageId,
              state: 'failed',
              failedAt: now,
              failure: input.failure ?? UNKNOWN_SENDER_OUTCOME,
            })
            .where(eq(verificationSenderAttempts.id, attempt.id));
          if (current)
            await this.merchantFailure(
              tx,
              dispatch,
              attempt,
              input.failure ?? UNKNOWN_SENDER_OUTCOME,
              new Date().toISOString(),
            );
        } else {
          await tx
            .update(verificationSenderAttempts)
            .set({
              providerMessageId: input.providerMessageId,
              acceptedAt: attempt.acceptedAt ?? now,
              state: 'accepted',
              ...(input.status !== 'sent'
                ? { deliveredAt: attempt.deliveredAt ?? now }
                : {}),
              ...(input.status === 'read'
                ? { readAt: attempt.readAt ?? now }
                : {}),
            })
            .where(eq(verificationSenderAttempts.id, attempt.id));
          if (!current || (input.status === 'sent' && attempt.failedAt)) return;
          await this.projectAcceptedVerification(tx, dispatch, {
            providerMessageId: input.providerMessageId,
            sentAt: attempt.acceptedAt ?? now,
            repair:
              dispatch.state === 'accepted' &&
              dispatch.senderRecoveryState === 'complete',
            template: recordedDispatchTemplate(dispatch),
          });
          await tx
            .update(verificationMessageDispatches)
            .set({
              state: 'accepted',
              providerMessageId: input.providerMessageId,
              acceptedAt: attempt.acceptedAt ?? now,
              failedAt: null,
              ...(input.status !== 'sent' ? { deliveredAt: now } : {}),
              ...(input.status === 'read' ? { readAt: now } : {}),
              senderRecoveryState: 'complete',
              senderRecoveryDueAt:
                dispatch.senderRecoveryState === 'retry'
                  ? now
                  : dispatch.senderRecoveryDueAt,
              senderAutomationPending:
                dispatch.senderRecoveryState === 'retry' ||
                dispatch.senderAutomationPending,
              leaseUntil: null,
              updatedAt: now,
            })
            .where(eq(verificationMessageDispatches.id, dispatch.id));
          if (input.status !== 'sent')
            await tx
              .update(verifications)
              .set({
                status:
                  input.status === 'read'
                    ? 'read'
                    : sql`CASE WHEN ${verifications.status} = 'read' THEN 'read'::verification_status ELSE 'delivered'::verification_status END`,
                deliveredAt: now,
                ...(input.status === 'read' ? { readAt: now } : {}),
                updatedAt: now,
              })
              .where(
                and(
                  eq(verifications.id, dispatch.verificationId),
                  eq(verifications.orgId, dispatch.orgId),
                  notInArray(verifications.status, WEBHOOK_PROTECTED_STATUSES),
                ),
              );
        }
      }),
    );
    return result;
  }

  async dueSenderRecovery(): Promise<SenderRecoveryWork[]> {
    const pending = await this.db
      .select({ providerMessageId: providerMessageReceipts.providerMessageId })
      .from(providerMessageReceipts)
      .innerJoin(
        verificationSenderAttempts,
        eq(
          verificationSenderAttempts.providerMessageId,
          providerMessageReceipts.providerMessageId,
        ),
      )
      .where(
        and(
          isNull(providerMessageReceipts.appliedAt),
          isNotNull(providerMessageReceipts.senderReceiptContext),
        ),
      )
      .limit(100);
    for (const receipt of pending)
      await this.drainMerchantReceipts(receipt.providerMessageId);
    const expired = await this.db
      .select()
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.senderKind, 'merchant_own'),
          sql`((${verificationMessageDispatches.state} = 'sending' AND ${verificationMessageDispatches.leaseUntil} < now()) OR (${verificationMessageDispatches.state} = 'outcome_unknown' AND ${verificationMessageDispatches.providerMessageId} IS NULL))`,
          notInArray(verificationMessageDispatches.kind, [
            'acknowledgment',
            'change_acknowledgment',
          ]),
        ),
      )
      .limit(100);
    for (const dispatch of expired)
      await this.failMerchantAttempt(
        dispatch.orgId,
        dispatch.id,
        null,
        UNKNOWN_SENDER_OUTCOME,
      );
    const rows = await this.db
      .select()
      .from(verificationMessageDispatches)
      .where(
        sql`(${verificationMessageDispatches.senderRecoveryState} IN ('retry','fallback') OR ${verificationMessageDispatches.senderAutomationPending}) AND ${verificationMessageDispatches.senderRecoveryDueAt} <= now()`,
      )
      .limit(100);
    return rows.map((row) => ({
      dispatchId: row.id,
      orgId: row.orgId,
      verificationId: row.verificationId,
      action: row.senderRecoveryState === 'retry' ? 'retry' : 'fallback',
      dueAt: row.senderRecoveryDueAt!,
      version: row.senderRecoveryVersion,
    }));
  }

  async findForSender(
    orgId: string,
    dispatchId: string,
    verificationId: string,
  ) {
    const [row] = await this.db
      .select()
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.id, dispatchId),
          eq(verificationMessageDispatches.orgId, orgId),
          eq(verificationMessageDispatches.verificationId, verificationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Crashed thank-you sends are reconciled, never reclaimed or resent. */
  async expireAcknowledgmentLeases(): Promise<number> {
    const rows = await this.db.execute(sql`
      WITH expired AS (
        SELECT id FROM verification_message_dispatches
        WHERE kind::text IN ('acknowledgment', 'change_acknowledgment') AND state = 'sending' AND lease_until < now()
        ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED
      )
      UPDATE verification_message_dispatches dispatch
      SET state = 'outcome_unknown', last_error_code = 'dispatch_lease_expired', lease_until = NULL, updated_at = now()
      FROM expired WHERE dispatch.id = expired.id RETURNING dispatch.id
    `);
    return rows.length;
  }

  async acknowledgmentEnabledForVerification(
    verificationId: string,
    orgId: string,
    repliedAt: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({
        enabled: integrations.acknowledgmentEnabled,
        enabledAt: integrations.acknowledgmentEnabledAt,
      })
      .from(verifications)
      .innerJoin(
        orders,
        and(eq(orders.id, verifications.orderId), eq(orders.orgId, orgId)),
      )
      .innerJoin(
        integrations,
        and(
          eq(integrations.id, orders.integrationId),
          eq(integrations.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(verifications.id, verificationId),
          eq(verifications.orgId, orgId),
          eq(integrations.isActive, true),
        ),
      )
      .limit(1);
    return acknowledgmentOptedIn(row?.enabled, row?.enabledAt, repliedAt);
  }

  async markAccepted(params: {
    dispatchId: string;
    providerMessageId: string;
    sentAt: string;
    verificationId?: string;
    kind?: DispatchKind;
    generation?: number;
    staffAudit?: StaffResolutionAudit;
    /**
     * What the adapter reports it sent. Without it (a staff resolution, or an
     * adapter that does not report) the identity the claim wrote stands.
     */
    sentTemplate?: SentTemplateIdentity;
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
            await this.settlePrepaid(
              tx,
              dispatch,
              'consume',
              params.sentAt,
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
            template: recordedDispatchTemplate(dispatch),
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
          await this.settlePrepaid(
            tx,
            dispatch,
            'consume',
            params.sentAt,
            params.staffAudit?.userId,
          );
        }
        if (
          isServiceDispatchKind(dispatch.kind) &&
          dispatch.accountingMode === 'prepaid_credit' &&
          dispatch.failedAt &&
          !dispatch.deliveredAt &&
          !dispatch.readAt
        ) {
          await this.settlePrepaid(
            tx,
            dispatch,
            'reverse',
            params.sentAt,
            params.staffAudit?.userId,
          );
        }
        const restoreReleasedUsage =
          dispatch.accountingMode !== 'prepaid_credit' &&
          dispatch.state === 'outcome_unknown' &&
          !dispatch.usageReserved &&
          dispatch.usagePeriodStart !== null &&
          !(isServiceDispatchKind(dispatch.kind) && dispatch.failedAt);
        if (restoreReleasedUsage) {
          await this.accounting.periodic.restore(tx, dispatch, params.sentAt);
        }
        // The verification gets the template in the same statement as the
        // message id, so the two always describe the same message.
        await this.projectAcceptedVerification(tx, dispatch, {
          providerMessageId: params.providerMessageId,
          sentAt: params.sentAt,
          template: params.sentTemplate ?? recordedDispatchTemplate(dispatch),
        });
        const [updated] = await tx
          .update(verificationMessageDispatches)
          .set({
            state: 'accepted',
            ...sentTemplateColumns(params.sentTemplate),
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
        // Receipts that beat this commit were parked; this is where they land.
        if (updated) await this.drainPendingReceipts(tx, updated);
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
    template?: SentTemplateIdentity;
  }): Promise<number> {
    return this.projectAcceptedVerification(
      this.db,
      { verificationId: params.verificationId, kind: params.kind },
      {
        providerMessageId: params.providerMessageId,
        sentAt: params.sentAt,
        template: params.template,
      },
    );
  }

  /** Returns how many dispatch rows were parked, so a no-op is not mistaken
   * for a successful write.
   *
   * A salvaged send records its wamid here, so receipts that were parked
   * waiting for it are applied here too; otherwise an early failure receipt
   * stayed unapplied and kept the usage it should have released. */
  async markOutcomeUnknown(
    dispatchId: string,
    errorCode: string,
    providerMessageId?: string,
  ): Promise<number> {
    let merchantAcceptance = false;
    const count = await this.withDispatchTransaction(dispatchId, async (tx) => {
      const rows = await tx
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
        .returning();
      if (rows[0]?.senderKind === 'merchant_own' && providerMessageId) {
        const attempts = await tx
          .update(verificationSenderAttempts)
          .set({
            providerMessageId,
            acceptedAt: new Date().toISOString(),
            state: 'accepted',
          })
          .where(
            and(
              eq(verificationSenderAttempts.dispatchId, dispatchId),
              eq(verificationSenderAttempts.orgId, rows[0].orgId),
              eq(
                verificationSenderAttempts.attemptNumber,
                rows[0].senderRetryCount,
              ),
              sql`${verificationSenderAttempts.state} IN ('authorized','in_flight')`,
            ),
          )
          .returning({ id: verificationSenderAttempts.id });
        merchantAcceptance = attempts.length > 0;
      }
      if (rows[0] && !merchantAcceptance)
        await this.drainPendingReceipts(tx, rows[0]);
      return rows.length;
    });
    if (merchantAcceptance && providerMessageId)
      await this.drainMerchantReceipts(providerMessageId);
    return count;
  }

  /**
   * Records a provider call that produced no message id.
   *
   * The dispatch remains `outcome_unknown` because the absence of a provider
   * id is not proof that no message was sent.
   *
   * The two accounting systems answer that ambiguity differently, on purpose.
   * Periodic usage follows the merchant-facing lifecycle: while the
   * verification is failed the reservation is released, and a later staff
   * resolution as accepted restores it in {@link markAccepted}. A prepaid
   * credit hold is kept instead -- releasing it would hand back a credit for a
   * message that may well have been delivered -- and only an audited staff
   * resolution consumes or releases it.
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

  /**
   * The language and variant of the newest send the provider accepted for a
   * verification, so a reply to it can be written in the same language and
   * dialect. NULL before any accepted send.
   */
  async findLatestAcceptedIdentity(verificationId: string): Promise<{
    resolvedLanguage: (typeof verificationMessageDispatches.$inferSelect)['resolvedLanguage'];
    variantKey: string | null;
  } | null> {
    const [row] = await this.db
      .select({
        resolvedLanguage: verificationMessageDispatches.resolvedLanguage,
        variantKey: verificationMessageDispatches.templateVariantKey,
      })
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.verificationId, verificationId),
          isNotNull(verificationMessageDispatches.acceptedAt),
          notInArray(verificationMessageDispatches.kind, [
            'acknowledgment',
            'change_acknowledgment',
          ]),
        ),
      )
      .orderBy(desc(verificationMessageDispatches.acceptedAt))
      .limit(1);
    return row ?? null;
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
    failureInfo?: { code?: number | string; title?: string },
  ): Promise<ReceiptProjection> {
    return this.withDispatchTransaction(dispatchId, async (tx) => {
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, dispatchId))
        .for('update');
      if (!dispatch) return;
      return this.applyReceipt(tx, dispatch, status, occurredAt, failureInfo);
    });
  }

  /**
   * Resolves a delivery receipt to what it describes, or parks it.
   *
   * Meta can report a message delivered before the transaction that stores its
   * wamid has committed -- routinely for prepaid sends, whose acceptance also
   * moves credits under the organization's credit lock. Such a receipt used to
   * match nothing and be dropped for good, since the webhook still answers 200.
   * It is parked instead, and {@link drainPendingReceipts} applies it when the
   * acceptance records the wamid.
   *
   * Both sides take the same per-wamid lock, and both run at READ COMMITTED, so
   * whichever goes second sees what the first committed: the lookup here waits
   * for an acceptance in flight and then finds its dispatch, or the drain waits
   * for this insert and then finds the receipt. This transaction holds nothing
   * else and commits before the caller applies the receipt under the credit
   * lock, so the two lock orders never nest in opposite directions.
   */
  async resolveOrParkReceipt(
    receipt: ProviderReceipt,
  ): Promise<ReceiptResolution> {
    return this.db.transaction(async (tx) => {
      await lockProviderMessage(tx, receipt.providerMessageId);
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(
          eq(
            verificationMessageDispatches.providerMessageId,
            receipt.providerMessageId,
          ),
        )
        .limit(1);
      if (dispatch) return { outcome: 'dispatch' as const, dispatch };
      // Verifications sent before the dispatch ledger existed carry the wamid
      // only on the row itself.
      const [verification] = await tx
        .select({ id: verifications.id })
        .from(verifications)
        .where(eq(verifications.waMessageId, receipt.providerMessageId))
        .limit(1);
      if (verification) return { outcome: 'verification' as const };
      await tx
        .insert(providerMessageReceipts)
        .values({
          providerMessageId: receipt.providerMessageId,
          status: receipt.status,
          occurredAt: receipt.occurredAt,
          errorCode:
            receipt.failureInfo?.code !== undefined
              ? String(receipt.failureInfo.code)
              : null,
          errorTitle: receipt.failureInfo?.title ?? null,
          senderReceiptContext: receipt.senderReceiptContext ?? null,
        })
        .onConflictDoNothing();
      return { outcome: 'parked' as const };
    });
  }

  /**
   * Applies the receipts parked for a dispatch's wamid, oldest first, inside
   * the transaction that has just recorded that wamid.
   *
   * Each receipt goes through {@link applyReceipt}, the same rules the webhook
   * path uses, so credit reversal and the verification projection cannot
   * differ with arrival order. A periodic-plan dispatch has no ledger-side
   * projection, so its verification is updated here with the lifecycle rules
   * `VerificationsRepository.updateStatus` applies to a live receipt.
   */
  private async drainPendingReceipts(
    tx: CreditTransaction,
    dispatch: DispatchRecord,
  ): Promise<void> {
    const providerMessageId = dispatch.providerMessageId;
    if (!providerMessageId) return;
    await lockProviderMessage(tx, providerMessageId);
    const pending = await tx
      .select()
      .from(providerMessageReceipts)
      .where(
        and(
          eq(providerMessageReceipts.providerMessageId, providerMessageId),
          isNull(providerMessageReceipts.appliedAt),
        ),
      )
      .orderBy(asc(providerMessageReceipts.occurredAt))
      .for('update');
    let current = dispatch;
    for (const receipt of pending) {
      const failureInfo =
        receipt.status === 'failed'
          ? {
              ...(receipt.errorCode !== null
                ? { code: receipt.errorCode }
                : {}),
              ...(receipt.errorTitle !== null
                ? { title: receipt.errorTitle }
                : {}),
            }
          : undefined;
      const projection = await this.applyReceipt(
        tx,
        current,
        receipt.status,
        receipt.occurredAt,
        failureInfo,
      );
      if (!projection) {
        await tx
          .update(verifications)
          .set(
            buildVerificationLifecyclePayload(
              receipt.status,
              receipt.occurredAt,
              new Date().toISOString(),
              failureInfo,
            ),
          )
          .where(
            and(
              eq(verifications.id, dispatch.verificationId),
              notInArray(verifications.status, WEBHOOK_PROTECTED_STATUSES),
            ),
          );
      }
      await tx
        .update(providerMessageReceipts)
        .set({ appliedAt: new Date().toISOString() })
        .where(eq(providerMessageReceipts.id, receipt.id));
      // Later receipts must see what earlier ones wrote (a `failed` after a
      // `delivered` is ignored on that basis).
      const [reloaded] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(eq(verificationMessageDispatches.id, dispatch.id));
      current = reloaded ?? current;
    }
  }

  /**
   * Records one provider receipt against a locked dispatch: its ledger
   * timestamps, any credit reversal, and — for prepaid dispatches — the
   * verification projection. Returns `undefined` for periodic-plan dispatches,
   * whose verification the caller projects.
   */
  private async applyReceipt(
    tx: CreditTransaction,
    dispatch: DispatchRecord,
    status: 'delivered' | 'read' | 'failed',
    occurredAt: string,
    failureInfo?: { code?: number | string; title?: string },
  ): Promise<ReceiptProjection> {
    if (
      dispatch.accountingMode === 'prepaid_credit' ||
      isServiceDispatchKind(dispatch.kind)
    ) {
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
      if (dispatch.state !== 'accepted' && dispatch.state !== 'outcome_unknown')
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
        if (
          dispatch.state === 'accepted' &&
          dispatch.accountingMode === 'prepaid_credit'
        )
          await this.settlePrepaid(tx, dispatch, 'reverse', occurredAt);
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
    if (isServiceDispatchKind(dispatch.kind)) {
      if (status === 'failed' && dispatch.kind === 'change_acknowledgment') {
        await tx
          .update(verificationChangeRequestEffects)
          .set({
            status: 'failed',
            reason: 'delivery_failed',
            completedAt: occurredAt,
            leaseUntil: null,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(verificationChangeRequestEffects.orgId, dispatch.orgId),
              eq(
                verificationChangeRequestEffects.kind,
                'customer_acknowledgment',
              ),
              sql`${verificationChangeRequestEffects.changeRequestId} IN (SELECT id FROM verification_change_requests WHERE verification_id = ${dispatch.verificationId} AND org_id = ${dispatch.orgId} AND confirmation_cycle = ${dispatch.confirmationCycle})`,
            ),
          );
      }
      if (status === 'failed')
        await tx
          .update(verificationServiceMessages)
          .set({
            state: 'failed',
            skipReason: 'delivery_failed',
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(verificationServiceMessages.dispatchId, dispatch.id),
              eq(verificationServiceMessages.orgId, dispatch.orgId),
              eq(verificationServiceMessages.state, 'sent'),
            ),
          );
      return { verificationRows: [] };
    }
    if (dispatch.accountingMode === 'prepaid_credit') {
      // The projection resolves against the provider message id, so a dispatch
      // parked without one has no verification row to address. The receipt is
      // still recorded above; there is simply nothing to project it onto.
      if (!dispatch.providerMessageId) return { verificationRows: [] };
      const noWhatsapp =
        status === 'failed' &&
        classifyDeliveryFailure(failureInfo?.code) === 'no_whatsapp';
      const verificationRows = await tx
        .update(verifications)
        .set(
          noWhatsapp
            ? {
                ...buildNoWhatsappPayload(occurredAt, failureInfo),
                updatedAt: occurredAt,
              }
            : {
                status:
                  status === 'failed'
                    ? 'failed'
                    : status === 'read'
                      ? 'read'
                      : sql`CASE WHEN ${verifications.status} = 'read' THEN ${verifications.status} ELSE 'delivered'::verification_status END`,
                ...(status === 'failed'
                  ? {
                      metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify(
                        {
                          reason: 'provider_delivery_failed',
                          ...(failureInfo?.code !== undefined
                            ? { providerErrorCode: failureInfo.code }
                            : {}),
                          ...(failureInfo?.title
                            ? { providerErrorTitle: failureInfo.title }
                            : {}),
                        },
                      )}::jsonb`,
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
              },
        )
        .where(
          and(
            eq(verifications.id, dispatch.verificationId),
            eq(verifications.waMessageId, dispatch.providerMessageId),
            notInArray(verifications.status, WEBHOOK_PROTECTED_STATUSES),
          ),
        )
        .returning();
      return { verificationRows };
    }
  }

  /**
   * Customer messages WhatsApp accepted for one source since `since`: initial
   * sends, reminders and thank-yous, which all use plan messages. Billing-exempt onboarding tests are excluded because
   * they are not order traffic; the plan recommendation sizes on this number.
   */
  /**
   * Accepted chargeable sends since a moment, in total and by the plan pool
   * that paid for each. A send recorded before the pool was stored was paid
   * from the Akeed pool, the only one there was.
   */
  async countAcceptedSince(params: {
    orgId: string;
    integrationId: string;
    since: string;
  }): Promise<{ total: number; akeed: number; ownNumber: number }> {
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        ownNumber: sql<number>`(count(*) filter (where ${verificationMessageDispatches.billingPool} = 'own_number'))::int`,
      })
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.orgId, params.orgId),
          eq(verificationMessageDispatches.integrationId, params.integrationId),
          sql`${verificationMessageDispatches.acceptedAt} >= ${params.since}`,
          sql`coalesce((${verificationMessageDispatches.metadata} ->> 'billingExempt')::boolean, false) = false`,
        ),
      );
    const total = row?.count ?? 0;
    const ownNumber = row?.ownNumber ?? 0;
    return { total, akeed: total - ownNumber, ownNumber };
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

  async findChangeAcknowledgment(
    verificationId: string,
    orgId: string,
    cycle: number,
  ) {
    const [row] = await this.db
      .select()
      .from(verificationMessageDispatches)
      .where(
        and(
          eq(verificationMessageDispatches.verificationId, verificationId),
          eq(verificationMessageDispatches.orgId, orgId),
          eq(verificationMessageDispatches.kind, 'change_acknowledgment'),
          eq(verificationMessageDispatches.confirmationCycle, cycle),
        ),
      )
      .limit(1);
    return row;
  }

  async resolveNotAccepted(
    id: string,
    staffAudit?: StaffResolutionAudit,
    confirmedRejection = false,
    providerErrorCode?: string,
  ): Promise<DispatchRecord | undefined> {
    const noWhatsapp =
      classifyDeliveryFailure(providerErrorCode) === 'no_whatsapp';
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
        await this.settlePrepaid(
          tx,
          dispatch,
          'release',
          now,
          staffAudit?.userId,
        );
      }
      if (dispatch.accountingMode !== 'prepaid_credit')
        await this.accounting.periodic.release(tx, dispatch, now);
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
      if (isServiceDispatchKind(dispatch.kind)) {
        if (staffAudit)
          await this.auditResolution(tx, dispatch, 'not_accepted', staffAudit);
        return updated;
      }
      if (noWhatsapp) {
        // The provider refused the message because the number cannot receive
        // WhatsApp. Same rules as an undeliverable receipt.
        await tx
          .update(verifications)
          .set({
            ...buildNoWhatsappPayload(now, { code: providerErrorCode }),
            updatedAt: now,
          })
          .where(
            and(
              eq(verifications.id, dispatch.verificationId),
              notInArray(verifications.status, WEBHOOK_PROTECTED_STATUSES),
            ),
          );
      } else {
        await tx
          .update(verifications)
          .set({
            status: statusUnlessTerminal('failed'),
            metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ reason: 'provider_not_accepted', kind: dispatch.kind })}::jsonb`,
            updatedAt: now,
          })
          .where(eq(verifications.id, dispatch.verificationId));
      }
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
      return { outcome: 'blocked', reason: 'CREDIT_ACCOUNT_NOT_PROVISIONED' };
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
          ...(params.kind === 'change_acknowledgment'
            ? [
                eq(
                  verificationMessageDispatches.confirmationCycle,
                  params.confirmationCycle ?? 1,
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(verificationMessageDispatches.generation))
      .limit(1)
      .for('update');
    if (dispatch && dispatch.integrationId !== params.integrationId)
      throw new Error('Dispatch identity mismatch');
    if (
      dispatch?.senderKind === 'merchant_own' &&
      !isServiceDispatchKind(dispatch.kind) &&
      ((dispatch.state === 'outcome_unknown' && !dispatch.providerMessageId) ||
        (dispatch.state === 'sending' &&
          dispatch.leaseUntil &&
          new Date(dispatch.leaseUntil) < new Date()))
    ) {
      const [attempt] = await tx
        .select()
        .from(verificationSenderAttempts)
        .where(
          and(
            eq(verificationSenderAttempts.dispatchId, dispatch.id),
            eq(verificationSenderAttempts.orgId, dispatch.orgId),
          ),
        )
        .orderBy(desc(verificationSenderAttempts.attemptNumber))
        .limit(1);
      await this.merchantFailure(
        tx,
        dispatch,
        attempt,
        UNKNOWN_SENDER_OUTCOME,
        new Date().toISOString(),
      );
      return { outcome: 'busy', dispatch };
    }
    if (
      !params.fallbackForDispatchId &&
      dispatch?.senderKind === 'merchant_own' &&
      !isServiceDispatchKind(dispatch.kind) &&
      ['retry', 'fallback', 'canceled'].includes(
        dispatch.senderRecoveryState ?? '',
      )
    )
      return { outcome: 'busy', dispatch };
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
    if (
      isServiceDispatchKind(params.kind) &&
      dispatch &&
      dispatch.attemptCount > 0
    )
      return { outcome: 'busy', dispatch };
    // A prepaid claim is always a fresh attempt: a ready row or a new
    // generation, never a reclaim of a recorded one.
    const senderKind = this.claimedSenderKind(
      params,
      dispatch?.state === 'ready' ? dispatch : undefined,
    );
    const rule = params.chargeRule ?? 'standard';
    const denial = await this.accounting.newHoldDenial(
      tx,
      params.orgId,
      rule === 'fallback' ? 0 : nextSendDisplayedCost(senderKind),
    );
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
        : (previous?.generation ??
          (params.kind === 'change_acknowledgment'
            ? (params.confirmationCycle ?? 1)
            : 1));
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
          fallbackForDispatchId: params.fallbackForDispatchId ?? null,
          kind: params.kind,
          state: 'ready',
          ...claimTemplateColumns(params),
          ...claimCycleColumns(params),
          changeRequestButtons: params.changeRequestButtons ?? false,
          recipientHash: params.recipientHash,
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
    const senderColumns = await this.claimSenderColumns(tx, params, dispatch);
    const locked = await this.accounting.prepaid.lock(tx, params.orgId);
    const charge = decidePrepaidCharge({
      sender: senderColumns.senderKind ?? senderKind,
      rule,
      snapshot: {
        availableStored: locked.postedBalance - locked.heldCredits,
        spare: locked.spareCredit,
      },
    });
    if (!charge.allowed) return { outcome: 'blocked', reason: charge.reason };
    if (charge.action === 'reserve')
      await this.accounting.prepaid.hold(tx, dispatch);
    else if (charge.action !== 'none')
      await this.accounting.prepaid.chargeSpare(tx, dispatch, charge.action);
    const [claimed] = await tx
      .update(verificationMessageDispatches)
      .set({
        state: 'sending',
        ...senderColumns,
        billingPool: charge.pool,
        billingCost: charge.cost,
        ...claimTemplateColumns(params),
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
        if (!source || !usesPrepaidCredits(source)) reconciliationRequired();
        await this.accounting.prepaid.lock(tx, dispatch.orgId);
      } else if (dispatch) {
        // A second write to the dispatch row in one transaction (acceptance
        // followed by a drained receipt) re-runs its foreign-key check, which
        // takes KEY SHARE on the source. `claim` holds that source FOR UPDATE
        // while it waits on the dispatch, so taking it here, before the
        // dispatch, keeps the order source -> dispatch on every path. Without
        // it the two deadlocked (40P01 in `sendOnce.persistAcceptance`).
        await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(
            and(
              eq(integrations.id, dispatch.integrationId),
              eq(integrations.orgId, dispatch.orgId),
            ),
          )
          .for('key share');
      }
      return work(tx);
    });
  }

  private async auditResolution(
    tx: CreditTransaction,
    dispatch: DispatchRecord,
    resolution: 'accepted' | 'not_accepted',
    actor: StaffResolutionAudit,
  ) {
    await tx.insert(adminAccessAudit).values({
      userId: actor.userId,
      action: 'message-dispatch.resolve',
      outcome: 'allowed',
      requestId: actor.requestId,
      targetIntegrationId: dispatch.integrationId,
      metadata: {
        dispatchId: dispatch.id,
        orgId: dispatch.orgId,
        verificationId: dispatch.verificationId,
        kind: dispatch.kind,
        generation: dispatch.generation,
        accountingMode: dispatch.accountingMode,
        resolution,
        reason: actor.reason.trim(),
        ...(actor.evidence ? { evidence: actor.evidence.trim() } : {}),
      },
    });
  }

  private async projectAcceptedVerification(
    tx: DispatchWriter,
    dispatch: Pick<DispatchRecord, 'kind' | 'verificationId'>,
    params: {
      providerMessageId: string;
      sentAt: string;
      repair?: boolean;
      template?: SentTemplateIdentity;
    },
  ): Promise<number> {
    if (isServiceDispatchKind(dispatch.kind)) return 0;
    const common = {
      waMessageId: params.providerMessageId,
      ...(params.template
        ? {
            templateName: params.template.templateName,
            languageCode: params.template.languageCode,
          }
        : {}),
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
