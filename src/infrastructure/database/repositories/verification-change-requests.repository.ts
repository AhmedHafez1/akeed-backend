import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, or, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  integrations,
  orders,
  verificationAutoCancellationEvents,
  verificationAutoCancellations,
  verificationChangeRequestEffects,
  verificationChangeRequestEvents,
  verificationChangeRequests,
  verificationMessageDispatches,
  verifications,
} from '../schema';
import type { CommerceOutcomeOperationResult } from '../../../shared/commerce/commerce-outcome';
import { isSyntheticOrder } from '../../../shared/commerce/synthetic-order';
import {
  AUTO_CANCEL_COMMITTED_STATUSES,
  AUTO_CANCEL_STOPPABLE_STATUSES,
} from '../../../shared/verification/auto-cancel.policy';
import {
  CHANGE_REQUEST_AUTO_CANCEL_STOP_REASON,
  CHANGE_REQUEST_OPEN_EFFECTS,
  CHANGE_REQUEST_OPENABLE_STATUSES,
  CYCLE_SCOPED_METADATA_KEYS,
  MERCHANT_CHANGE_REQUEST_CANCELLATION_SOURCE,
  customerResolutionOf,
  evaluateChangeRequestOpen,
  type ChangeRequestActorKind,
  type ChangeRequestEffectKind,
  type ChangeRequestEffectStatus,
  type ChangeRequestEvent,
  type ChangeRequestRejectReason,
  type ChangeRequestResolution,
  type ShippingState,
} from '../../../shared/verification/change-request.policy';
import type { CustomerReplyIntent } from '../../../shared/verification/customer-reply-intent';
import { isTerminalStatus } from '../../../shared/verification/verification-lifecycle';
import { customerRecipientHash } from '../../../shared/messaging/change-request-messaging';
import { buildVerificationLifecyclePayload } from './verifications.repository';

type Transaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
type Writer = DrizzleDB | Transaction;

export type ChangeRequestRow = typeof verificationChangeRequests.$inferSelect;
export type ChangeRequestEventRow =
  typeof verificationChangeRequestEvents.$inferSelect;
export type ChangeRequestEffectRow =
  typeof verificationChangeRequestEffects.$inferSelect;
type VerificationRow = typeof verifications.$inferSelect;

/** Messages a customer can answer with the confirmation buttons. */
const ANSWERABLE_DISPATCH_KINDS = ['initial', 'follow_up'] as const;

/** What the customer's message says about the sender it reached. */
export interface ChangeRequestSender {
  kind: 'akeed_system' | 'merchant_own';
  /** The business phone number that received the customer's tap. */
  phoneNumberId?: string | null;
  connectionId?: string | null;
  signupGeneration?: number;
}

export interface OpenChangeRequestInput {
  /** Required by the customer transport; omitted only by internal domain callers. */
  recipientHash?: string | null;
  requireChangeButton?: boolean;
  /** The verification the button names. Never inferred from a phone. */
  verificationId: string;
  /** The tenant the receiving number belongs to, when routing knows it. */
  expectedOrgId?: string;
  /** The wamid of the confirmation message the customer answered. */
  sourceProviderMessageId: string;
  /** The cycle the button carries; legacy buttons carry none. */
  cycle?: number;
  sender: ChangeRequestSender;
  /** The provider's id of the customer's message, for replay detection. */
  eventId: string;
  occurredAt: string;
  /** Read by the caller before the transaction; `unknown` never blocks. */
  shipping: ShippingState;
}

export type OpenRejectReason =
  | ChangeRequestRejectReason
  | 'verification_not_found'
  | 'tenant_mismatch'
  | 'message_mismatch'
  | 'sender_mismatch'
  | 'recipient_mismatch'
  | 'older_customer_choice'
  | 'button_unavailable';

export type OpenChangeRequestResult =
  | {
      outcome: 'opened';
      request: ChangeRequestRow;
      effects: ChangeRequestEffectKind[];
      /** The automatic cancellation this request stopped, if any. */
      stoppedAutoCancellation: boolean;
    }
  | { outcome: 'already_open'; request: ChangeRequestRow }
  | { outcome: 'rejected'; reason: OpenRejectReason };

export type ResolveRejectReason =
  | 'verification_not_found'
  | 'no_open_request'
  | 'request_mismatch'
  | 'stale_cycle'
  | 'not_awaiting_confirmation'
  | 'auto_cancel_committed';

export type MerchantResolutionResult =
  | {
      outcome: 'resolved';
      request: ChangeRequestRow;
      verification: VerificationRow;
    }
  | {
      /** Someone else settled it first; nothing was changed. */
      outcome: 'already_resolved';
      request: ChangeRequestRow | null;
      verificationStatus: string;
    }
  | { outcome: 'rejected'; reason: ResolveRejectReason };

export type ReconfirmationResult =
  | {
      outcome: 'completed';
      request: ChangeRequestRow;
      confirmationCycle: number;
    }
  | {
      outcome: 'already_resolved';
      request: ChangeRequestRow | null;
      verificationStatus: string;
    }
  | { outcome: 'rejected'; reason: ResolveRejectReason };

interface LockedContext {
  verification: VerificationRow;
  openRequest: ChangeRequestRow | null;
}

/**
 * Customer change requests: the request, its history and its side-effect
 * outbox.
 *
 * Every transition runs in one transaction that locks the verification row
 * first, then the automatic cancellation row, then the request: the order the
 * automatic cancellation, the reminder claim and the no-reply guard already
 * use, so a request, a customer answer, a merchant action, a reminder and a
 * cancellation can never interleave. Effects are written in the same
 * transaction and carried out afterwards; nothing here calls a provider.
 *
 * Every merchant-facing method is scoped by `orgId`; a verification of
 * another tenant reads as not found.
 */
@Injectable()
export class VerificationChangeRequestsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findOpenForVerification(
    verificationId: string,
    orgId: string,
  ): Promise<ChangeRequestRow | undefined> {
    const [row] = await this.db
      .select()
      .from(verificationChangeRequests)
      .where(
        and(
          eq(verificationChangeRequests.verificationId, verificationId),
          eq(verificationChangeRequests.orgId, orgId),
          eq(verificationChangeRequests.status, 'open'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * The order a button names, for the store read taken before a request
   * opens. Unlocked: `open` checks everything again under the lock.
   */
  async findOrderForVerification(verificationId: string): Promise<
    | {
        orgId: string;
        verificationStatus: string;
        integrationId: string;
        externalOrderId: string;
        isTest: boolean;
      }
    | undefined
  > {
    const [row] = await this.db
      .select({
        orgId: verifications.orgId,
        verificationStatus: verifications.status,
        integrationId: orders.integrationId,
        externalOrderId: orders.externalOrderId,
        isTest: orders.isTest,
      })
      .from(verifications)
      .innerJoin(
        orders,
        and(
          eq(orders.id, verifications.orderId),
          eq(orders.orgId, verifications.orgId),
        ),
      )
      .where(eq(verifications.id, verificationId))
      .limit(1);
    return row;
  }

  async findById(
    id: string,
    orgId: string,
  ): Promise<ChangeRequestRow | undefined> {
    const [row] = await this.db
      .select()
      .from(verificationChangeRequests)
      .where(
        and(
          eq(verificationChangeRequests.id, id),
          eq(verificationChangeRequests.orgId, orgId),
        ),
      )
      .limit(1);
    return row;
  }

  /** The requests of one page of the confirmations list, open or not. */
  async findByVerificationIds(
    orgId: string,
    verificationIds: readonly string[],
  ): Promise<ChangeRequestRow[]> {
    if (verificationIds.length === 0) return [];
    return this.db
      .select()
      .from(verificationChangeRequests)
      .where(
        and(
          eq(verificationChangeRequests.orgId, orgId),
          inArray(verificationChangeRequests.verificationId, [
            ...verificationIds,
          ]),
        ),
      )
      .orderBy(desc(verificationChangeRequests.openedAt));
  }

  /** The audit trail of one request, oldest first. */
  async listHistory(
    changeRequestId: string,
    orgId: string,
  ): Promise<ChangeRequestEventRow[]> {
    return this.db
      .select()
      .from(verificationChangeRequestEvents)
      .where(
        and(
          eq(verificationChangeRequestEvents.changeRequestId, changeRequestId),
          eq(verificationChangeRequestEvents.orgId, orgId),
        ),
      )
      .orderBy(asc(verificationChangeRequestEvents.createdAt));
  }

  async listEffects(
    changeRequestId: string,
    orgId: string,
  ): Promise<ChangeRequestEffectRow[]> {
    return this.db
      .select()
      .from(verificationChangeRequestEffects)
      .where(
        and(
          eq(verificationChangeRequestEffects.changeRequestId, changeRequestId),
          eq(verificationChangeRequestEffects.orgId, orgId),
        ),
      )
      .orderBy(asc(verificationChangeRequestEffects.createdAt));
  }

  /**
   * Opens the customer's request, or recognizes it as a repeat.
   *
   * The button is trusted only through the message it answered: that message
   * must be an accepted confirmation or reminder of the same verification and
   * tenant, sent from the sender that received the tap, in the cycle the
   * verification is in now. A repeated tap or a replayed webhook finds the
   * open request and creates nothing; the replay is recorded once.
   */
  async open(input: OpenChangeRequestInput): Promise<OpenChangeRequestResult> {
    return this.db.transaction(async (tx) => {
      const [verification] = await tx
        .select()
        .from(verifications)
        .where(eq(verifications.id, input.verificationId))
        .for('update');
      if (!verification)
        return { outcome: 'rejected', reason: 'verification_not_found' };
      if (input.expectedOrgId && verification.orgId !== input.expectedOrgId)
        return { outcome: 'rejected', reason: 'tenant_mismatch' };
      const orgId = verification.orgId;

      const [order] = await tx
        .select({
          id: orders.id,
          integrationId: orders.integrationId,
          externalOrderId: orders.externalOrderId,
          isTest: orders.isTest,
        })
        .from(orders)
        .where(
          and(eq(orders.id, verification.orderId), eq(orders.orgId, orgId)),
        );
      if (!order)
        return { outcome: 'rejected', reason: 'verification_not_found' };
      const [integration] = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(
            eq(integrations.id, order.integrationId),
            eq(integrations.orgId, orgId),
          ),
        );
      if (!integration)
        return { outcome: 'rejected', reason: 'verification_not_found' };

      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(
          and(
            eq(
              verificationMessageDispatches.providerMessageId,
              input.sourceProviderMessageId,
            ),
            eq(verificationMessageDispatches.orgId, orgId),
          ),
        );
      if (
        !dispatch ||
        dispatch.verificationId !== verification.id ||
        dispatch.integrationId !== order.integrationId ||
        dispatch.state !== 'accepted' ||
        !(ANSWERABLE_DISPATCH_KINDS as readonly string[]).includes(
          dispatch.kind,
        ) ||
        (input.cycle !== undefined &&
          input.cycle !== dispatch.confirmationCycle)
      )
        return { outcome: 'rejected', reason: 'message_mismatch' };
      if (!senderMatches(dispatch, input.sender))
        return { outcome: 'rejected', reason: 'sender_mismatch' };
      if (input.requireChangeButton) {
        if (
          !input.sender.phoneNumberId ||
          dispatch.senderPhoneNumberId !== input.sender.phoneNumberId
        )
          return { outcome: 'rejected', reason: 'sender_mismatch' };
        if (!dispatch.changeRequestButtons)
          return { outcome: 'rejected', reason: 'button_unavailable' };
        if (
          !input.recipientHash ||
          input.recipientHash !== dispatch.recipientHash
        )
          return { outcome: 'rejected', reason: 'recipient_mismatch' };
        if (this.olderChoice(verification, input))
          return { outcome: 'rejected', reason: 'older_customer_choice' };
      }

      const [autoCancel] = await tx
        .select()
        .from(verificationAutoCancellations)
        .where(
          eq(verificationAutoCancellations.verificationId, verification.id),
        )
        .for('update');
      const openRequest = await this.lockOpenRequest(tx, verification.id);

      const decision = evaluateChangeRequestOpen({
        status: verification.status,
        merchantCanceledAt: verification.merchantCanceledAt,
        isTestOrder: isSyntheticOrder(order),
        currentCycle: verification.confirmationCycle,
        eventCycle: dispatch.confirmationCycle,
        shipping: input.shipping,
        autoCancelCommitted: Boolean(
          autoCancel &&
          (AUTO_CANCEL_COMMITTED_STATUSES as readonly string[]).includes(
            autoCancel.status,
          ),
        ),
        hasOpenRequest: Boolean(openRequest),
      });

      if (decision.kind === 'reject')
        return { outcome: 'rejected', reason: decision.reason };
      if (decision.kind === 'already_open' && openRequest) {
        if (input.requireChangeButton)
          await this.saveChoice(tx, verification.id, input);
        if (input.eventId !== openRequest.openedEventId) {
          await this.appendEvent(tx, {
            request: openRequest,
            event: 'repeat_ignored',
            actorKind: 'customer',
            sourceEventId: input.eventId,
          });
        }
        return { outcome: 'already_open', request: openRequest };
      }

      const [request] = await tx
        .insert(verificationChangeRequests)
        .values({
          orgId,
          integrationId: order.integrationId,
          orderId: order.id,
          verificationId: verification.id,
          confirmationCycle: verification.confirmationCycle,
          sourceDispatchId: dispatch.id,
          sourceProviderMessageId: input.sourceProviderMessageId,
          senderKind: dispatch.senderKind,
          senderPhoneNumberId: dispatch.senderPhoneNumberId,
          senderConnectionId: dispatch.senderConnectionId,
          openedEventId: input.eventId,
          openedAt: input.occurredAt,
        })
        .onConflictDoNothing()
        .returning();
      // A request of this cycle exists and is no longer open: the cycle was
      // already settled, so a late tap cannot reopen it.
      if (!request)
        return { outcome: 'rejected', reason: 'not_awaiting_confirmation' };

      let stoppedAutoCancellation = false;
      if (
        autoCancel &&
        (AUTO_CANCEL_STOPPABLE_STATUSES as readonly string[]).includes(
          autoCancel.status,
        )
      ) {
        await tx
          .update(verificationAutoCancellations)
          .set({
            status: 'stopped',
            reason: CHANGE_REQUEST_AUTO_CANCEL_STOP_REASON,
            dueAt: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(verificationAutoCancellations.id, autoCancel.id));
        await tx.insert(verificationAutoCancellationEvents).values({
          orgId,
          verificationId: verification.id,
          event: 'stopped',
          detail: { reason: CHANGE_REQUEST_AUTO_CANCEL_STOP_REASON },
        });
        stoppedAutoCancellation = true;
      }

      await this.appendEvent(tx, {
        request,
        event: 'opened',
        actorKind: 'customer',
        sourceEventId: input.eventId,
        detail: {
          status: verification.status,
          shipping: input.shipping,
          dispatchKind: dispatch.kind,
          ...(stoppedAutoCancellation ? { stoppedAutoCancellation } : {}),
        },
      });
      await this.addEffects(tx, request, CHANGE_REQUEST_OPEN_EFFECTS);
      if (input.requireChangeButton)
        await this.saveChoice(tx, verification.id, input);
      return {
        outcome: 'opened',
        request,
        effects: [...CHANGE_REQUEST_OPEN_EFFECTS],
        stoppedAutoCancellation,
      };
    });
  }

  /** A bound current-cycle answer and request closure commit under the same verification lock. */
  async applyCustomerAnswer(
    input: Omit<OpenChangeRequestInput, 'shipping'> & {
      intent: CustomerReplyIntent;
    },
  ): Promise<{
    outcome: 'applied' | 'already_applied' | 'rejected';
    reason?: string;
    orgId?: string;
  }> {
    return this.db.transaction(async (tx) => {
      const [verification] = await tx
        .select()
        .from(verifications)
        .where(eq(verifications.id, input.verificationId))
        .for('update');
      if (
        !verification ||
        (input.expectedOrgId && verification.orgId !== input.expectedOrgId)
      )
        return { outcome: 'rejected', reason: 'tenant_mismatch' };
      const [dispatch] = await tx
        .select()
        .from(verificationMessageDispatches)
        .where(
          and(
            eq(
              verificationMessageDispatches.providerMessageId,
              input.sourceProviderMessageId,
            ),
            eq(verificationMessageDispatches.orgId, verification.orgId),
          ),
        );
      if (
        !dispatch ||
        dispatch.verificationId !== verification.id ||
        dispatch.state !== 'accepted' ||
        !ANSWERABLE_DISPATCH_KINDS.includes(
          dispatch.kind as 'initial' | 'follow_up',
        )
      )
        return { outcome: 'rejected', reason: 'message_mismatch' };
      if (
        dispatch.confirmationCycle !== verification.confirmationCycle ||
        (input.cycle !== undefined &&
          input.cycle !== dispatch.confirmationCycle)
      )
        return { outcome: 'rejected', reason: 'stale_cycle' };
      if (!senderMatches(dispatch, input.sender))
        return { outcome: 'rejected', reason: 'sender_mismatch' };
      if (
        dispatch.changeRequestButtons &&
        (!input.sender.phoneNumberId ||
          input.sender.phoneNumberId !== dispatch.senderPhoneNumberId)
      )
        return { outcome: 'rejected', reason: 'sender_mismatch' };
      const [order] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.id, verification.orderId),
            eq(orders.orgId, verification.orgId),
            eq(orders.integrationId, dispatch.integrationId),
          ),
        );
      if (
        !order ||
        !input.recipientHash ||
        input.recipientHash !==
          (dispatch.recipientHash ?? customerRecipientHash(order.customerPhone))
      )
        return { outcome: 'rejected', reason: 'recipient_mismatch' };
      if (
        verification.customerActionEventId === input.eventId &&
        verification.status === input.intent
      )
        return { outcome: 'already_applied', orgId: verification.orgId };
      if (this.olderChoice(verification, input))
        return { outcome: 'rejected', reason: 'older_customer_choice' };
      if (
        verification.merchantCanceledAt ||
        isTerminalStatus(verification.status)
      )
        return { outcome: 'rejected', reason: 'already_terminal' };
      const [autoCancel] = await tx
        .select()
        .from(verificationAutoCancellations)
        .where(
          eq(verificationAutoCancellations.verificationId, verification.id),
        )
        .for('update');
      if (
        autoCancel &&
        (AUTO_CANCEL_COMMITTED_STATUSES as readonly string[]).includes(
          autoCancel.status,
        )
      )
        return { outcome: 'rejected', reason: 'auto_cancel_committed' };
      if (
        autoCancel &&
        (AUTO_CANCEL_STOPPABLE_STATUSES as readonly string[]).includes(
          autoCancel.status,
        )
      ) {
        await tx
          .update(verificationAutoCancellations)
          .set({
            status: 'stopped',
            reason: 'customer_replied',
            dueAt: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(verificationAutoCancellations.id, autoCancel.id));
        await tx.insert(verificationAutoCancellationEvents).values({
          orgId: verification.orgId,
          verificationId: verification.id,
          event: 'stopped',
          detail: { reason: 'customer_replied', intent: input.intent },
        });
      }
      await tx
        .update(verifications)
        .set({
          status: input.intent,
          ...buildVerificationLifecyclePayload(
            input.intent,
            input.occurredAt,
            new Date().toISOString(),
          ),
          ...(input.intent === 'confirmed'
            ? { confirmedAt: input.occurredAt, confirmationSource: 'customer' }
            : { canceledAt: input.occurredAt, cancellationSource: 'customer' }),
          customerActionAt: input.occurredAt,
          customerActionEventId: input.eventId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(verifications.id, verification.id));
      const request = await this.lockOpenRequest(tx, verification.id);
      if (
        request &&
        request.confirmationCycle === verification.confirmationCycle
      )
        await this.close(tx, request, {
          resolution: customerResolutionOf(input.intent),
          actorKind: 'customer',
          sourceEventId: input.eventId,
          resolvedAt: input.occurredAt,
        });
      return { outcome: 'applied', orgId: verification.orgId };
    });
  }

  private olderChoice(
    verification: VerificationRow,
    input: { occurredAt: string; eventId: string },
  ): boolean {
    if (!verification.customerActionAt) return false;
    const difference =
      Date.parse(input.occurredAt) - Date.parse(verification.customerActionAt);
    return (
      difference < 0 ||
      (difference === 0 &&
        input.eventId <= (verification.customerActionEventId ?? ''))
    );
  }

  private async saveChoice(
    tx: Transaction,
    id: string,
    input: { occurredAt: string; eventId: string },
  ): Promise<void> {
    await tx
      .update(verifications)
      .set({
        customerActionAt: input.occurredAt,
        customerActionEventId: input.eventId,
      })
      .where(eq(verifications.id, id));
  }

  /**
   * The customer's own Confirm or Cancel settled the order. Called after the
   * answer was written: it closes the open request only when the
   * verification shows that very answer from the customer, so a merchant
   * outcome or an ignored answer never closes it under the customer's name.
   * Idempotent: a repeat finds nothing open.
   */
  async resolveByCustomerAnswer(input: {
    verificationId: string;
    intent: CustomerReplyIntent;
    eventId?: string;
    occurredAt?: string;
  }): Promise<{ outcome: 'resolved'; request: ChangeRequestRow } | null> {
    return this.db.transaction(async (tx) => {
      const [verification] = await tx
        .select()
        .from(verifications)
        .where(eq(verifications.id, input.verificationId))
        .for('update');
      if (!verification || verification.status !== input.intent) return null;
      const answeredByCustomer =
        input.intent === 'confirmed'
          ? verification.confirmationSource === 'customer'
          : verification.cancellationSource === 'customer';
      if (!answeredByCustomer) return null;
      const openRequest = await this.lockOpenRequest(tx, verification.id);
      if (
        !openRequest ||
        openRequest.confirmationCycle !== verification.confirmationCycle
      )
        return null;
      const request = await this.close(tx, openRequest, {
        resolution: customerResolutionOf(input.intent),
        actorKind: 'customer',
        sourceEventId: input.eventId,
        resolvedAt: input.occurredAt,
      });
      return { outcome: 'resolved', request };
    });
  }

  /**
   * The merchant confirmed the order after contacting the customer. One
   * guarded transaction: the order is confirmed exactly as a manual
   * confirmation is, and the request closes with the merchant as actor.
   */
  async resolveByMerchantConfirmation(input: {
    orgId: string;
    verificationId: string;
    changeRequestId?: string;
    actorUserId: string;
  }): Promise<MerchantResolutionResult> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lockForMerchant(tx, input);
      if ('outcome' in locked) return locked;
      const { verification, openRequest } = locked;
      const now = new Date().toISOString();
      const [updated] = await tx
        .update(verifications)
        .set({
          status: 'confirmed',
          confirmedAt: now,
          confirmationSource: 'merchant_manual',
          metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ manualConfirmedBy: input.actorUserId })}::jsonb`,
          updatedAt: now,
        })
        .where(eq(verifications.id, verification.id))
        .returning();
      const request = await this.close(tx, openRequest, {
        resolution: 'merchant_confirmed',
        actorKind: 'merchant',
        actorUserId: input.actorUserId,
        resolvedAt: now,
      });
      return { outcome: 'resolved', request, verification: updated };
    });
  }

  /**
   * The merchant canceled the order after contacting the customer. Called
   * once the store accepted the cancellation, as the no-reply cancellation
   * is; the request closes with the merchant as actor.
   */
  async resolveByMerchantCancellation(input: {
    orgId: string;
    verificationId: string;
    changeRequestId?: string;
    actorUserId: string;
    operation?: CommerceOutcomeOperationResult;
  }): Promise<MerchantResolutionResult> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lockForMerchant(tx, input);
      if ('outcome' in locked) return locked;
      const { verification, openRequest } = locked;
      const now = new Date().toISOString();
      const [updated] = await tx
        .update(verifications)
        .set({
          status: 'canceled',
          canceledAt: now,
          merchantCanceledAt: now,
          cancellationSource: MERCHANT_CHANGE_REQUEST_CANCELLATION_SOURCE,
          ...(input.operation
            ? {
                metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ commerceCancellation: input.operation })}::jsonb`,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(verifications.id, verification.id))
        .returning();
      const request = await this.close(tx, openRequest, {
        resolution: 'merchant_canceled',
        actorKind: 'merchant',
        actorUserId: input.actorUserId,
        resolvedAt: now,
      });
      return { outcome: 'resolved', request, verification: updated };
    });
  }

  /**
   * An updated confirmation was not sent: refused for allowance, failed at
   * the provider, or fresh order details were unavailable. The request stays
   * open and the automation stays stopped; only the reason is recorded.
   */
  async recordReconfirmationFailure(input: {
    orgId: string;
    verificationId: string;
    changeRequestId: string;
    reason: string;
    actorUserId?: string | null;
  }): Promise<'recorded' | 'not_open'> {
    return this.db.transaction(async (tx) => {
      const [verification] = await this.lockVerificationForOrg(
        tx,
        input.verificationId,
        input.orgId,
      );
      if (!verification) return 'not_open';
      const openRequest = await this.lockOpenRequest(tx, verification.id);
      if (!openRequest || openRequest.id !== input.changeRequestId)
        return 'not_open';
      const reason = input.reason.slice(0, 64) || 'unknown';
      await tx
        .update(verificationChangeRequests)
        .set({
          lastReconfirmationError: reason,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(verificationChangeRequests.id, openRequest.id));
      await this.appendEvent(tx, {
        request: openRequest,
        event: 'reconfirmation_failed',
        actorKind: input.actorUserId ? 'merchant' : 'system',
        actorUserId: input.actorUserId ?? null,
        detail: { reason },
      });
      return 'recorded';
    });
  }

  /**
   * The updated confirmation was accepted by the provider. In one
   * transaction the order moves to the next cycle, which retires every
   * earlier button and job; it reads as freshly sent, with the previous
   * cycle's receipts, reminder and escalation state cleared so the normal
   * timers start again; and the request closes as `reconfirmation_sent`.
   *
   * `expectedCycle` is the cycle the request was opened in: a concurrent
   * customer answer, merchant outcome or second resend that won first makes
   * this one change nothing.
   */
  async completeReconfirmation(input: {
    orgId: string;
    verificationId: string;
    changeRequestId: string;
    expectedCycle: number;
    providerMessageId: string;
    sentAt: string;
    actorUserId?: string | null;
  }): Promise<ReconfirmationResult> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lockForMerchant(tx, input);
      if ('outcome' in locked) return locked;
      const { verification, openRequest } = locked;
      if (
        openRequest.confirmationCycle !== input.expectedCycle ||
        verification.confirmationCycle !== input.expectedCycle
      )
        return { outcome: 'rejected', reason: 'stale_cycle' };

      // The previous cycle's cancellation decision does not carry over; one
      // that reached the store already made `lockForMerchant` refuse.
      await tx
        .delete(verificationAutoCancellations)
        .where(
          and(
            eq(verificationAutoCancellations.verificationId, verification.id),
            inArray(verificationAutoCancellations.status, [
              'scheduled',
              'paused',
              'skipped',
              'stopped',
              'failed',
            ]),
          ),
        );

      const now = new Date().toISOString();
      const nextCycle = verification.confirmationCycle + 1;
      await tx
        .update(verifications)
        .set({
          status: 'sent',
          confirmationCycle: nextCycle,
          customerActionAt: null,
          customerActionEventId: null,
          waMessageId: input.providerMessageId,
          lastSentAt: input.sentAt,
          deliveredAt: null,
          readAt: null,
          noReplyAt: null,
          noWhatsappAt: null,
          deliveryErrorCode: null,
          followUpSentAt: null,
          followUpAttempts: 0,
          nextRetryAt: null,
          metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) - ARRAY[${sql.join(
            [...CYCLE_SCOPED_METADATA_KEYS, 'reason', 'kind'].map(
              (key) => sql`${key}`,
            ),
            sql`, `,
          )}]::text[]`,
          updatedAt: now,
        })
        .where(eq(verifications.id, verification.id));
      const request = await this.close(tx, openRequest, {
        resolution: 'reconfirmation_sent',
        actorKind: input.actorUserId ? 'merchant' : 'system',
        actorUserId: input.actorUserId ?? null,
        resolvedAt: now,
        detail: { confirmationCycle: nextCycle },
      });
      return { outcome: 'completed', request, confirmationCycle: nextCycle };
    });
  }

  /**
   * Takes one pending effect of a kind for a worker, leased so a crashed
   * worker's effect is taken again later. `SKIP LOCKED` keeps two workers
   * from taking the same row.
   */
  async claimEffect(
    kind: ChangeRequestEffectKind,
    leaseMs: number,
    now: Date = new Date(),
    changeRequestId?: string,
  ): Promise<ChangeRequestEffectRow | null> {
    return this.db.transaction(async (tx) => {
      const nowIso = now.toISOString();
      const [candidate] = await tx
        .select()
        .from(verificationChangeRequestEffects)
        .where(
          and(
            eq(verificationChangeRequestEffects.kind, kind),
            ...(changeRequestId
              ? [
                  eq(
                    verificationChangeRequestEffects.changeRequestId,
                    changeRequestId,
                  ),
                ]
              : []),
            or(
              eq(verificationChangeRequestEffects.status, 'pending'),
              and(
                eq(verificationChangeRequestEffects.status, 'in_progress'),
                or(
                  isNull(verificationChangeRequestEffects.leaseUntil),
                  lte(verificationChangeRequestEffects.leaseUntil, nowIso),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(verificationChangeRequestEffects.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!candidate) return null;
      const [claimed] = await tx
        .update(verificationChangeRequestEffects)
        .set({
          status: 'in_progress',
          attempts: candidate.attempts + 1,
          leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
          updatedAt: nowIso,
        })
        .where(eq(verificationChangeRequestEffects.id, candidate.id))
        .returning();
      return claimed ?? null;
    });
  }

  /**
   * Records how a claimed effect ended. Guarded on the attempt that claimed
   * it, so a worker whose lease ran out cannot overwrite a newer attempt.
   */
  async settleEffect(input: {
    effectId: string;
    attempts: number;
    status: Extract<
      ChangeRequestEffectStatus,
      'done' | 'skipped' | 'failed' | 'pending'
    >;
    reason?: string | null;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await this.db
      .update(verificationChangeRequestEffects)
      .set({
        status: input.status,
        reason: input.reason ? input.reason.slice(0, 64) : null,
        leaseUntil: null,
        completedAt: input.status === 'pending' ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationChangeRequestEffects.id, input.effectId),
          eq(verificationChangeRequestEffects.status, 'in_progress'),
          eq(verificationChangeRequestEffects.attempts, input.attempts),
        ),
      )
      .returning({ id: verificationChangeRequestEffects.id });
    return rows.length > 0;
  }

  private async lockVerificationForOrg(
    tx: Transaction,
    verificationId: string,
    orgId: string,
  ) {
    return tx
      .select()
      .from(verifications)
      .where(
        and(
          eq(verifications.id, verificationId),
          eq(verifications.orgId, orgId),
        ),
      )
      .for('update');
  }

  private async lockOpenRequest(
    tx: Transaction,
    verificationId: string,
  ): Promise<ChangeRequestRow | null> {
    const [row] = await tx
      .select()
      .from(verificationChangeRequests)
      .where(
        and(
          eq(verificationChangeRequests.verificationId, verificationId),
          eq(verificationChangeRequests.status, 'open'),
        ),
      )
      .for('update');
    return row ?? null;
  }

  /**
   * The verification and its open request for a merchant command, both
   * locked, or the answer for one that can no longer act: the request was
   * settled first (by the customer, another merchant tab or a resend), the
   * order is not awaiting confirmation, or the store is already canceling it.
   */
  private async lockForMerchant(
    tx: Transaction,
    input: { orgId: string; verificationId: string; changeRequestId?: string },
  ): Promise<
    | (LockedContext & { openRequest: ChangeRequestRow })
    | Exclude<MerchantResolutionResult, { outcome: 'resolved' }>
  > {
    const [verification] = await this.lockVerificationForOrg(
      tx,
      input.verificationId,
      input.orgId,
    );
    if (!verification)
      return { outcome: 'rejected', reason: 'verification_not_found' };
    const [autoCancel] = await tx
      .select({ status: verificationAutoCancellations.status })
      .from(verificationAutoCancellations)
      .where(eq(verificationAutoCancellations.verificationId, verification.id))
      .for('update');
    const openRequest = await this.lockOpenRequest(tx, verification.id);
    if (!openRequest) {
      const [latest] = await tx
        .select()
        .from(verificationChangeRequests)
        .where(
          and(
            eq(verificationChangeRequests.verificationId, verification.id),
            eq(verificationChangeRequests.orgId, input.orgId),
          ),
        )
        .orderBy(desc(verificationChangeRequests.confirmationCycle))
        .limit(1);
      return latest
        ? {
            outcome: 'already_resolved',
            request: latest,
            verificationStatus: verification.status,
          }
        : { outcome: 'rejected', reason: 'no_open_request' };
    }
    if (input.changeRequestId && input.changeRequestId !== openRequest.id)
      return { outcome: 'rejected', reason: 'request_mismatch' };
    // The customer's answer landed first and its close is about to follow.
    if (isTerminalStatus(verification.status))
      return {
        outcome: 'already_resolved',
        request: openRequest,
        verificationStatus: verification.status,
      };
    if (
      verification.merchantCanceledAt ||
      !(CHANGE_REQUEST_OPENABLE_STATUSES as readonly string[]).includes(
        verification.status,
      )
    )
      return { outcome: 'rejected', reason: 'not_awaiting_confirmation' };
    if (
      autoCancel &&
      (AUTO_CANCEL_COMMITTED_STATUSES as readonly string[]).includes(
        autoCancel.status,
      )
    )
      return { outcome: 'rejected', reason: 'auto_cancel_committed' };
    return { verification, openRequest };
  }

  private async close(
    tx: Transaction,
    openRequest: ChangeRequestRow,
    input: {
      resolution: ChangeRequestResolution;
      actorKind: ChangeRequestActorKind;
      actorUserId?: string | null;
      sourceEventId?: string;
      resolvedAt?: string;
      detail?: Record<string, unknown>;
    },
  ): Promise<ChangeRequestRow> {
    const now = new Date().toISOString();
    const [request] = await tx
      .update(verificationChangeRequests)
      .set({
        status: 'resolved',
        resolution: input.resolution,
        resolvedAt: input.resolvedAt ?? now,
        resolvedByUserId: input.actorUserId ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationChangeRequests.id, openRequest.id),
          eq(verificationChangeRequests.status, 'open'),
        ),
      )
      .returning();
    await this.appendEvent(tx, {
      request: openRequest,
      event: 'resolved',
      actorKind: input.actorKind,
      actorUserId: input.actorUserId ?? null,
      sourceEventId: input.sourceEventId,
      detail: { resolution: input.resolution, ...input.detail },
    });
    await this.addEffects(tx, openRequest, ['platform_marker_clear']);
    return request;
  }

  private async appendEvent(
    tx: Writer,
    input: {
      request: Pick<ChangeRequestRow, 'id' | 'orgId' | 'verificationId'>;
      event: ChangeRequestEvent;
      actorKind: ChangeRequestActorKind;
      actorUserId?: string | null;
      sourceEventId?: string;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx
      .insert(verificationChangeRequestEvents)
      .values({
        orgId: input.request.orgId,
        changeRequestId: input.request.id,
        verificationId: input.request.verificationId,
        event: input.event,
        actorKind: input.actorKind,
        actorUserId: input.actorUserId ?? null,
        sourceEventId: input.sourceEventId ?? null,
        detail: input.detail ?? {},
      })
      .onConflictDoNothing();
  }

  private async addEffects(
    tx: Writer,
    request: Pick<ChangeRequestRow, 'id' | 'orgId'>,
    kinds: readonly ChangeRequestEffectKind[],
  ): Promise<void> {
    await tx
      .insert(verificationChangeRequestEffects)
      .values(
        kinds.map((kind) => ({
          orgId: request.orgId,
          changeRequestId: request.id,
          kind,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Whether the customer's tap reached the sender that sent the message. A
 * merchant-number message must come back on that number; a tap on another
 * number than the one recorded is refused rather than reassigned.
 */
function senderMatches(
  dispatch: Pick<
    typeof verificationMessageDispatches.$inferSelect,
    | 'senderKind'
    | 'senderPhoneNumberId'
    | 'senderConnectionId'
    | 'senderConnectionGeneration'
  >,
  sender: ChangeRequestSender,
): boolean {
  if (dispatch.senderKind !== sender.kind) return false;
  if (dispatch.senderKind === 'merchant_own')
    return (
      Boolean(sender.phoneNumberId) &&
      sender.phoneNumberId === dispatch.senderPhoneNumberId &&
      (sender.connectionId === undefined ||
        sender.connectionId === dispatch.senderConnectionId) &&
      (sender.signupGeneration === undefined ||
        sender.signupGeneration === dispatch.senderConnectionGeneration)
    );
  return (
    !dispatch.senderPhoneNumberId ||
    !sender.phoneNumberId ||
    sender.phoneNumberId === dispatch.senderPhoneNumberId
  );
}
