import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import { WebhookDispatchService } from '../webhook-queue/webhook-dispatch.service';
import { OrdersService } from '../orders/orders.service';
import type { MessageDispatchResolutionDto } from './dto/message-dispatch-resolution.dto';
import type { MessageDispatchResendDto } from './dto/message-dispatch-resend.dto';

@Injectable()
export class MessageDispatchResolutionService {
  constructor(
    private readonly dispatches: VerificationMessageDispatchesRepository,
    private readonly events: WebhookEventsRepository,
    private readonly webhookDispatcher: WebhookDispatchService,
    private readonly verificationHub: VerificationHubService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Staff confirm a first confirmation never reached the provider, then send
   * it again through the merchant's own retry, for every order source.
   *
   * Only a dispatch with no provider message id qualifies. Calling it again
   * after the dispatch was already resolved not accepted just retries, so a
   * resend that failed its readiness checks can be repeated.
   */
  async resendNotSent(
    staffUserId: string,
    dispatchId: string,
    input: MessageDispatchResendDto,
    context: { requestId?: string } = {},
  ) {
    const dispatch = await this.dispatches.findById(dispatchId);
    if (!dispatch) throw new NotFoundException('Message dispatch not found');
    const order = dispatch.verification?.order;
    if (
      dispatch.kind !== 'initial' ||
      dispatch.providerMessageId ||
      !order ||
      !['outcome_unknown', 'rejected'].includes(dispatch.state)
    ) {
      throw new ConflictException({
        code: 'MESSAGE_DISPATCH_RESEND_UNSUPPORTED',
        message:
          'Only a first confirmation with no provider message id, awaiting review, can be resent.',
      });
    }
    if (dispatch.state === 'outcome_unknown') {
      const resolved = await this.dispatches.resolveNotAccepted(dispatchId, {
        userId: staffUserId,
        reason: input.reason,
        ...context,
      });
      if (!resolved)
        throw new ConflictException('Dispatch could not be resolved');
    }
    const retry = await this.orders.retryVerificationForOrg(
      order.orgId,
      order.id,
    );
    return { dispatchId, state: 'rejected' as const, retry };
  }

  async resolve(
    staffUserId: string,
    dispatchId: string,
    input: MessageDispatchResolutionDto,
    context: { evidence?: string; requestId?: string } = {},
  ) {
    const dispatch = await this.dispatches.findById(dispatchId);
    if (!dispatch) throw new NotFoundException('Message dispatch not found');
    const identical =
      (input.resolution === 'accepted' &&
        dispatch.state === 'accepted' &&
        dispatch.providerMessageId === input.providerMessageId) ||
      (input.resolution === 'not_accepted' && dispatch.state === 'rejected');
    if (!identical && dispatch.state !== 'outcome_unknown') {
      throw new ConflictException({
        code: 'MESSAGE_DISPATCH_RESOLUTION_CONFLICT',
        message: `Dispatch is already ${dispatch.state}.`,
      });
    }

    if (input.resolution === 'accepted') {
      const acceptedAt = dispatch.acceptedAt ?? new Date().toISOString();
      const updated = await this.dispatches.markAccepted({
        dispatchId,
        providerMessageId: input.providerMessageId!,
        sentAt: acceptedAt,
        verificationId: dispatch.verificationId,
        // `legacy_unknown` has no logical dispatch key, so it cannot take part
        // in the key-based recovery; resolution then falls back to the id alone.
        kind: dispatch.kind === 'legacy_unknown' ? undefined : dispatch.kind,
        generation: dispatch.generation,
        staffAudit: { userId: staffUserId, reason: input.reason, ...context },
      });
      if (updated.outcome !== 'accepted')
        throw new ConflictException('Dispatch could not be resolved');
      const verification = dispatch.verification;
      const integration = verification?.order?.integration;
      if (dispatch.kind === 'initial' && verification && integration) {
        await this.verificationHub.scheduleFollowUpAndEscalation({
          verificationId: verification.id,
          orgId: verification.orgId,
          integration,
          baselineSentAt: new Date(updated.dispatch.acceptedAt ?? acceptedAt),
        });
      }
      return { dispatchId, state: 'accepted', duplicate: identical };
    }

    const updated = await this.dispatches.resolveNotAccepted(dispatchId, {
      userId: staffUserId,
      reason: input.reason,
      ...context,
    });
    if (!updated) throw new ConflictException('Dispatch could not be resolved');
    const order = dispatch.verification?.order;
    const event = order?.webhookEvents.find(
      (candidate) =>
        candidate.platform === 'standalone' &&
        candidate.jobType === 'order.create',
    );
    if (
      dispatch.kind !== 'acknowledgment' &&
      dispatch.kind !== 'change_acknowledgment' &&
      order &&
      event &&
      (await this.dispatches.isLatestGeneration(dispatchId))
    ) {
      const reset = await this.events.resetForRedispatch({
        id: event.id,
        orderId: order.id,
      });
      if (reset) await this.webhookDispatcher.dispatchById(event.id);
    }
    return { dispatchId, state: 'rejected', duplicate: identical };
  }
}
