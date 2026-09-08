import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import { VerificationMessageDispatchesRepository } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import { WebhookDispatchService } from '../webhook-queue/webhook-dispatch.service';
import type { MessageDispatchResolutionDto } from './dto/message-dispatch-resolution.dto';

@Injectable()
export class MessageDispatchResolutionService {
  constructor(
    private readonly dispatches: VerificationMessageDispatchesRepository,
    private readonly events: WebhookEventsRepository,
    private readonly webhookDispatcher: WebhookDispatchService,
    private readonly verificationHub: VerificationHubService,
    private readonly audit: AdminAccessAuditRepository,
  ) {}

  async resolve(
    staffUserId: string,
    dispatchId: string,
    input: MessageDispatchResolutionDto,
  ) {
    const dispatch = await this.dispatches.findById(dispatchId);
    if (!dispatch) throw new NotFoundException('Message dispatch not found');
    const identical =
      (input.resolution === 'accepted' &&
        dispatch.state === 'accepted' &&
        dispatch.providerMessageId === input.providerMessageId) ||
      (input.resolution === 'not_accepted' && dispatch.state === 'rejected');
    if (identical) {
      return { dispatchId, state: dispatch.state, duplicate: true };
    }
    if (dispatch.state !== 'outcome_unknown') {
      throw new ConflictException({
        code: 'MESSAGE_DISPATCH_RESOLUTION_CONFLICT',
        message: `Dispatch is already ${dispatch.state}.`,
      });
    }

    if (input.resolution === 'accepted') {
      const acceptedAt = new Date().toISOString();
      const updated = await this.dispatches.markAccepted({
        dispatchId,
        providerMessageId: input.providerMessageId!,
        sentAt: acceptedAt,
        verificationId: dispatch.verificationId,
        // `legacy_unknown` has no logical dispatch key, so it cannot take part
        // in the key-based recovery; resolution then falls back to the id alone.
        kind: dispatch.kind === 'legacy_unknown' ? undefined : dispatch.kind,
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
          baselineSentAt: new Date(acceptedAt),
        });
      }
      await this.recordAudit(staffUserId, dispatch, input);
      return { dispatchId, state: 'accepted', duplicate: false };
    }

    const updated = await this.dispatches.resolveNotAccepted(dispatchId);
    if (!updated) throw new ConflictException('Dispatch could not be resolved');
    const order = dispatch.verification?.order;
    const event = order?.webhookEvents.find(
      (candidate) =>
        candidate.platform === 'standalone' &&
        candidate.jobType === 'order.create',
    );
    if (order && event) {
      const reset = await this.events.resetForRedispatch({
        id: event.id,
        orderId: order.id,
      });
      if (reset) await this.webhookDispatcher.dispatchById(event.id);
    }
    await this.recordAudit(staffUserId, dispatch, input);
    return { dispatchId, state: 'rejected', duplicate: false };
  }

  private recordAudit(
    userId: string,
    dispatch: {
      id: string;
      integrationId: string;
      verificationId: string;
      kind: string;
    },
    input: MessageDispatchResolutionDto,
  ) {
    return this.audit.record({
      userId,
      action: 'message-dispatch.resolve',
      outcome: 'allowed',
      targetIntegrationId: dispatch.integrationId,
      metadata: {
        dispatchId: dispatch.id,
        verificationId: dispatch.verificationId,
        kind: dispatch.kind,
        resolution: input.resolution,
        reason: input.reason.trim(),
      },
    });
  }
}
