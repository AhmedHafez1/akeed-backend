import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  VerificationChangeRequestsRepository,
  type ChangeRequestEffectRow,
} from '../../infrastructure/database/repositories/verification-change-requests.repository';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import {
  MESSAGING_PORT,
  type MessagingPort,
  type FreeFormTextOutcome,
} from '../../shared/ports/messaging.port';
import {
  changeAcknowledgment,
  customerRecipientHash,
} from '../../shared/messaging/change-request-messaging';
import { CUSTOMER_SERVICE_WINDOW_MS } from '../../shared/messaging/message-texts.types';
import { withSerializableRetry } from '../../shared/database/serializable-retry';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

/** CR01's outbox is the source of truth. Provider creation is never blindly retried. */
@Injectable()
export class ChangeRequestAcknowledgmentService {
  private readonly logger = new Logger(ChangeRequestAcknowledgmentService.name);
  constructor(
    private readonly requests: VerificationChangeRequestsRepository,
    private readonly dispatches: VerificationMessageDispatchesRepository,
    private readonly orders: OrdersRepository,
    @Inject(MESSAGING_PORT) private readonly messaging: MessagingPort,
  ) {}

  async drain(changeRequestId?: string): Promise<void> {
    for (let count = 0; count < (changeRequestId ? 1 : 25); count++) {
      const effect = await this.requests.claimEffect(
        'customer_acknowledgment',
        120_000,
        new Date(),
        changeRequestId,
      );
      if (!effect) return;
      try {
        await this.send(effect);
      } catch (error) {
        this.logger.error(
          buildBackendLog(ChangeRequestAcknowledgmentService.name, {
            action: 'change-request-acknowledgment',
            outcome: 'retry',
            orgId: effect.orgId,
            effectId: effect.id,
            ...normalizeError(error),
          }),
        );
        // The lease is recoverable. A recorded sending dispatch fences another provider call.
        throw error;
      }
    }
  }

  private async send(effect: ChangeRequestEffectRow): Promise<void> {
    const finish = (status: 'done' | 'skipped' | 'failed', reason?: string) =>
      this.requests.settleEffect({
        effectId: effect.id,
        attempts: effect.attempts,
        status,
        reason,
      });
    const request = await this.requests.findById(
      effect.changeRequestId,
      effect.orgId,
    );
    if (!request) {
      await finish('skipped', 'request_unavailable');
      return;
    }
    const prior = await this.dispatches.findChangeAcknowledgment(
      request.verificationId,
      effect.orgId,
      request.confirmationCycle,
    );
    if (prior && prior.attemptCount > 0) {
      if (prior.state === 'sending')
        await withSerializableRetry(() =>
          this.dispatches.markFailedProviderOutcome(
            prior.id,
            'dispatch_lease_expired',
          ),
        );
      await finish(
        prior.state === 'accepted' ? 'done' : 'failed',
        prior.state === 'accepted' ? undefined : 'provider_outcome_uncertain',
      );
      return;
    }
    const source = await this.dispatches.findById(request.sourceDispatchId);
    const order = await this.orders.findById(request.orderId);
    if (
      !source ||
      source.orgId !== effect.orgId ||
      source.confirmationCycle !== request.confirmationCycle ||
      !source.resolvedLanguage ||
      !source.templateVariantKey ||
      !order ||
      order.orgId !== effect.orgId ||
      !order.integration ||
      order.integration.orgId !== effect.orgId ||
      customerRecipientHash(order.customerPhone) !== source.recipientHash
    ) {
      await finish('failed', 'origin_snapshot_unavailable');
      return;
    }
    if (
      Date.now() - Date.parse(request.openedAt) >=
      CUSTOMER_SERVICE_WINDOW_MS
    ) {
      await finish('skipped', 'outside_window');
      return;
    }
    if (!this.messaging.sendFreeFormText) {
      await finish('failed', 'service_reply_unavailable');
      return;
    }
    const language = source.resolvedLanguage;
    const fallbackStore = {
      ar: 'المتجر',
      en: 'the store',
      ur: 'اسٹور',
      es: 'la tienda',
      fr: 'la boutique',
      tr: 'mağaza',
    }[language];
    const body = changeAcknowledgment(
      language,
      source.templateVariantKey,
      order.integration.storeName?.trim() || fallbackStore,
      order.orderNumber?.trim() || order.externalOrderId,
    );
    const claim = await withSerializableRetry(() =>
      this.dispatches.claim({
        orgId: effect.orgId,
        integrationId: request.integrationId,
        verificationId: request.verificationId,
        kind: 'change_acknowledgment',
        confirmationCycle: request.confirmationCycle,
        changeRequestEffect: { id: effect.id, attempts: effect.attempts },
        templateName: null,
        languageCode: language,
        leaseUntil: new Date(Date.now() + 120_000).toISOString(),
        sender: {
          kind: source.senderKind,
          connectionId: source.senderConnectionId,
          reason: 'change_request_acknowledgment',
          units: 1,
        },
      }),
    );
    if (claim.outcome === 'blocked') return; // The accounting transaction settled the skip permanently.
    if (claim.outcome === 'accepted') {
      await finish('done');
      return;
    }
    if (claim.outcome !== 'claimed') {
      await finish('failed', 'provider_outcome_uncertain');
      return;
    }
    const dispatch = claim.dispatch;
    if (
      dispatch.senderPhoneNumberId !== source.senderPhoneNumberId ||
      dispatch.senderConnectionId !== source.senderConnectionId ||
      (source.senderKind === 'merchant_own' &&
        dispatch.senderConnectionGeneration !==
          source.senderConnectionGeneration)
    ) {
      await withSerializableRetry(() =>
        this.dispatches.resolveNotAccepted(dispatch.id, undefined, true),
      );
      await finish('failed', 'originating_sender_unavailable');
      return;
    }
    let result: FreeFormTextOutcome;
    try {
      result = await this.messaging.sendFreeFormText({
        to: order.customerPhone,
        body,
        verificationId: request.verificationId,
        dispatchContext: { orgId: effect.orgId, dispatchId: dispatch.id },
        ...(source.senderKind === 'merchant_own'
          ? {
              sender: {
                kind: 'merchant_own' as const,
                orgId: effect.orgId,
                serviceMessageId: dispatch.id,
                connectionId: source.senderConnectionId!,
                phoneNumberId: source.senderPhoneNumberId!,
                signupGeneration: source.senderConnectionGeneration!,
              },
            }
          : {}),
      });
    } catch {
      result = { outcome: 'failed', code: 'provider_error' };
    }
    if (result.outcome === 'accepted') {
      try {
        await withSerializableRetry(() =>
          this.dispatches.markAccepted({
            dispatchId: dispatch.id,
            verificationId: request.verificationId,
            kind: 'change_acknowledgment',
            generation: dispatch.generation,
            providerMessageId:
              result.outcome === 'accepted' ? result.providerMessageId : '',
            sentAt: new Date().toISOString(),
          }),
        );
      } catch (error) {
        await this.dispatches.markOutcomeUnknown(
          dispatch.id,
          'acceptance_persistence_failed',
          result.providerMessageId,
        );
        throw error;
      }
      await finish('done');
    } else if (result.outcome === 'failed') {
      await withSerializableRetry(() =>
        this.dispatches.markFailedProviderOutcome(dispatch.id, result.code),
      );
      await finish('failed', 'provider_outcome_uncertain');
    } else {
      await withSerializableRetry(() =>
        this.dispatches.resolveNotAccepted(dispatch.id, undefined, true),
      );
      await finish(
        result.outcome === 'window_closed' ? 'skipped' : 'failed',
        result.outcome === 'window_closed'
          ? 'window_closed'
          : 'provider_rejected',
      );
    }
  }
}
