import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  VerificationChangeRequestsRepository,
  type ChangeRequestRow,
} from '../../infrastructure/database/repositories/verification-change-requests.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import { throwMerchantRejection } from '../change-requests/change-request-lifecycle.service';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import { isCapacityBlockReason } from '../../shared/verification/capacity-block';
import { isSyntheticOrder } from '../../shared/commerce/synthetic-order';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  CURRENT_ORDER_SOURCES,
  currentDetailsOf,
  type CurrentOrderSource,
} from '../../shared/ports/current-order-source.port';
import {
  shippingStateFromInspection,
  type ReconfirmationFailureCode,
  type ReconfirmationState,
} from '../../shared/verification/change-request.policy';
import {
  adjustForQuietHours,
  isInsideQuietHours,
  quietHoursConfigOf,
} from '../../shared/utils/quiet-hours.util';
import { VerificationHubService } from './verification-hub.service';
import {
  VerificationSendService,
  type SendOutcome,
} from './verification-send.service';

/** What the dashboard shows of an updated confirmation in flight. */
export interface ReconfirmationView {
  changeRequestId: string;
  state: ReconfirmationState | null;
  scheduledFor: string | null;
  lastError: string | null;
}

export function reconfirmationViewOf(
  request: ChangeRequestRow,
): ReconfirmationView {
  return {
    changeRequestId: request.id,
    state: request.reconfirmationState ?? null,
    scheduledFor: request.reconfirmationScheduledFor ?? null,
    lastError: request.lastReconfirmationError ?? null,
  };
}

/** The reason a send outcome gives an updated confirmation that did not go. */
export function reconfirmationFailureOf(
  outcome: SendOutcome,
): ReconfirmationFailureCode | null {
  switch (outcome.status) {
    case 'sent':
    case 'sent_untracked':
    case 'recovery_pending':
      return null;
    case 'plan_limit_reached':
      return 'no_allowance';
    case 'outcome_unknown':
      return 'provider_outcome_unknown';
    case 'failed':
      return 'sending_failed';
    case 'skipped':
      if (isCapacityBlockReason(outcome.reason)) return 'no_allowance';
      if (outcome.reason === 'template_unavailable')
        return 'template_unavailable';
      if (outcome.reason === 'dispatch_in_progress')
        return 'provider_outcome_unknown';
      return 'sending_unavailable';
  }
}

/**
 * The merchant's "Send updated confirmation" for an open change request.
 *
 * Asking records an attempt on the request and queues it; the request stays
 * open, and the reminder and the no-reply automation stay stopped, until the
 * provider accepts the message. The job reads the order's current details
 * from its source (never sending what Akeed had stored when the read fails),
 * waits for quiet hours like any confirmation, and sends through the normal
 * confirmation path: the same sender choice, template and three-button
 * readiness, charge and recovery. The acceptance itself starts the new cycle
 * and closes the request, in the ledger's transaction; this service then
 * starts the new cycle's normal reminder and no-reply timers.
 */
@Injectable()
export class ChangeRequestReconfirmationService {
  private readonly logger = new Logger(ChangeRequestReconfirmationService.name);

  constructor(
    private readonly changeRequests: VerificationChangeRequestsRepository,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly ordersRepo: OrdersRepository,
    private readonly sendService: VerificationSendService,
    private readonly hub: VerificationHubService,
    private readonly commerceOutcomes: CommerceOutcomeRegistryService,
    private readonly automation: VerificationAutomationProducer,
    @Optional()
    @Inject(CURRENT_ORDER_SOURCES)
    private readonly sources: CurrentOrderSource[] = [],
  ) {}

  /**
   * The merchant asked. A second click while an attempt is queued, waiting
   * or sending joins it; nothing is sent twice.
   */
  async request(
    user: AuthenticatedUser,
    verificationId: string,
    input: { changeRequestId: string; expectedCycle: number },
  ): Promise<ReconfirmationView> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to send a confirmation.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    const result = await this.changeRequests.requestReconfirmation({
      orgId: user.orgId,
      verificationId,
      changeRequestId: input.changeRequestId,
      expectedCycle: input.expectedCycle,
      actorUserId: user.userId,
    });
    if (result.outcome === 'in_flight')
      return reconfirmationViewOf(result.request);
    if (result.outcome !== 'requested') return throwMerchantRejection(result);
    try {
      await this.automation.enqueueReconfirmation({
        verificationId,
        orgId: user.orgId,
        changeRequestId: result.request.id,
        attempt: result.request.reconfirmationAttempt,
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(ChangeRequestReconfirmationService.name, {
          action: 'change-request-reconfirmation-enqueue',
          outcome: 'failure',
          orgId: user.orgId,
          verificationId,
          ...normalizeError(error),
        }),
      );
      await this.changeRequests.recordReconfirmationFailure({
        orgId: user.orgId,
        verificationId,
        changeRequestId: result.request.id,
        reason: 'sending_unavailable',
        attempt: result.request.reconfirmationAttempt,
      });
      throw new ServiceUnavailableException({
        message: 'The updated confirmation could not be queued. Try again.',
        code: 'CHANGE_REQUEST_RECONFIRMATION_UNAVAILABLE',
      });
    }
    return reconfirmationViewOf(result.request);
  }

  /** The queued attempt runs. Safe to run twice: only one attempt sends. */
  async run(job: {
    verificationId: string;
    orgId: string;
    changeRequestId: string;
    attempt: number;
  }): Promise<void> {
    const request = await this.changeRequests.findById(
      job.changeRequestId,
      job.orgId,
    );
    if (
      !request ||
      request.status !== 'open' ||
      request.verificationId !== job.verificationId ||
      request.reconfirmationAttempt !== job.attempt ||
      (request.reconfirmationState !== 'requested' &&
        request.reconfirmationState !== 'scheduled')
    )
      return this.log(job, 'skipped', 'attempt_superseded');

    const verification = await this.verificationsRepo.findByIdForOrg(
      job.verificationId,
      job.orgId,
    );
    const order = verification
      ? await this.ordersRepo.findById(verification.orderId)
      : undefined;
    if (!verification || !order?.integration || order.orgId !== job.orgId)
      return this.fail(job, 'order_not_found');
    const integration = order.integration;

    // Quiet hours hold an updated confirmation like any confirmation.
    const quiet = quietHoursConfigOf(integration);
    const now = new Date();
    if (isInsideQuietHours(now, quiet)) {
      const dueAt = adjustForQuietHours(now, quiet);
      if (
        await this.changeRequests.markReconfirmationScheduled({
          orgId: job.orgId,
          changeRequestId: job.changeRequestId,
          attempt: job.attempt,
          scheduledFor: dueAt.toISOString(),
        })
      )
        await this.automation.enqueueReconfirmation({ ...job, dueAt });
      return this.log(job, 'skipped', 'quiet_hours');
    }

    const sending = await this.changeRequests.beginReconfirmationSend({
      orgId: job.orgId,
      changeRequestId: job.changeRequestId,
      attempt: job.attempt,
    });
    if (!sending) return this.log(job, 'skipped', 'attempt_superseded');

    // The store's own view first: an order that shipped or was canceled
    // there is not confirmed again.
    if (!isSyntheticOrder(order)) {
      const inspection = await this.commerceOutcomes.inspectForCancellation({
        orgId: job.orgId,
        integrationId: order.integrationId,
        externalOrderId: order.externalOrderId,
        action: 'automatic_no_reply_cancellation',
        correlationId: job.verificationId,
      });
      if (
        inspection.state === 'already_canceled' ||
        shippingStateFromInspection(inspection) === 'shipped'
      )
        return this.fail(job, 'order_not_eligible');
      if (
        inspection.state === 'not_cancellable' &&
        inspection.reason === 'order_not_found'
      )
        return this.fail(job, 'order_not_found');
    }

    const source = this.sources.find(
      (candidate) => candidate.platform === integration.platformType,
    );
    if (!source) return this.fail(job, 'order_source_unavailable');
    const current = await source.readCurrentOrder({
      orgId: job.orgId,
      integrationId: order.integrationId,
      externalOrderId: order.externalOrderId,
      connection: integration,
      stored: currentDetailsOf({
        customerPhone: order.customerPhone,
        customerName: order.customerName,
        totalPrice: order.totalPrice ?? '',
        currency: order.currency ?? '',
        paymentMethod: order.paymentMethod,
        lineItems: order.lineItems,
        shippingRegion: order.shippingRegion,
        shippingAddress: order.shippingAddress,
      }),
    });
    if (current.status !== 'found') return this.fail(job, current.code);
    await this.ordersRepo.refreshCurrentDetails(
      order.id,
      job.orgId,
      current.order,
    );

    let outcome: SendOutcome;
    try {
      outcome = await this.sendService.sendInitial(job.verificationId, {
        confirmationCycle: request.confirmationCycle + 1,
      });
    } catch (error) {
      this.logger.error(
        buildBackendLog(ChangeRequestReconfirmationService.name, {
          action: 'change-request-reconfirmation-send',
          outcome: 'failure',
          orgId: job.orgId,
          verificationId: job.verificationId,
          ...normalizeError(error),
        }),
      );
      return this.fail(job, 'provider_outcome_unknown');
    }
    await this.settle(job, outcome);
  }

  /**
   * After an own-number retry or fallback of an updated confirmation ended:
   * a failure is recorded for the merchant; an acceptance already closed
   * the request in its transaction.
   */
  async afterSenderRecovery(
    orgId: string,
    verificationId: string,
    outcome: SendOutcome,
  ): Promise<void> {
    const request = await this.changeRequests.findOpenForVerification(
      verificationId,
      orgId,
    );
    if (!request || request.reconfirmationState !== 'sending') return;
    const failure = reconfirmationFailureOf(outcome);
    if (!failure) return;
    await this.fail(
      {
        orgId,
        verificationId,
        changeRequestId: request.id,
        attempt: request.reconfirmationAttempt,
      },
      failure,
    );
  }

  private async settle(
    job: {
      verificationId: string;
      orgId: string;
      changeRequestId: string;
      attempt: number;
    },
    outcome: SendOutcome,
  ): Promise<void> {
    if (outcome.status === 'recovery_pending')
      return this.log(job, 'skipped', 'sender_recovery');
    const failure = reconfirmationFailureOf(outcome);
    if (failure) return this.fail(job, failure);

    const after = await this.changeRequests.findById(
      job.changeRequestId,
      job.orgId,
    );
    if (after?.status === 'open')
      // Sent, but the acceptance could not be recorded with its cycle; the
      // ledger holds it for reconciliation, which closes the request then.
      return this.fail(job, 'provider_outcome_unknown');
    if (after?.resolution !== 'reconfirmation_sent')
      return this.log(job, 'skipped', 'superseded');
    await this.startTimers(job, outcome);
    this.log(job, 'success', 'reconfirmation_sent');
  }

  /** The new cycle's normal reminder and no-reply timers. */
  private async startTimers(
    job: { verificationId: string; orgId: string },
    outcome: SendOutcome,
  ): Promise<void> {
    try {
      const verification = await this.verificationsRepo.findByIdForOrg(
        job.verificationId,
        job.orgId,
      );
      const order = verification
        ? await this.ordersRepo.findById(verification.orderId)
        : undefined;
      if (!verification || !order?.integration) return;
      // The earlier cycle's jobs keep fixed ids; clear them so the new
      // cycle's jobs are not ignored as duplicates.
      await this.automation.prepareRecoverySchedule({
        verificationId: job.verificationId,
        orgId: job.orgId,
      });
      await this.hub.scheduleFollowUpAndEscalation({
        verificationId: job.verificationId,
        orgId: job.orgId,
        integration: order.integration,
        baselineSentAt: outcome.sentAt ? new Date(outcome.sentAt) : new Date(),
      });
    } catch (error) {
      // The new cycle is committed; the follow-up sweep and the no-reply
      // guard read it. Logged for support rather than failing the send.
      this.logger.error(
        buildBackendLog(ChangeRequestReconfirmationService.name, {
          action: 'change-request-reconfirmation-timers',
          outcome: 'failure',
          orgId: job.orgId,
          verificationId: job.verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  private async fail(
    job: {
      verificationId: string;
      orgId: string;
      changeRequestId: string;
      attempt: number;
    },
    reason: ReconfirmationFailureCode,
  ): Promise<void> {
    await this.changeRequests.recordReconfirmationFailure({
      orgId: job.orgId,
      verificationId: job.verificationId,
      changeRequestId: job.changeRequestId,
      reason,
      attempt: job.attempt,
    });
    this.log(job, 'failure', reason);
  }

  private log(
    job: { verificationId: string; orgId: string; attempt?: number },
    outcome: 'success' | 'failure' | 'skipped',
    reason: string,
  ): void {
    this.logger.log(
      buildBackendLog(ChangeRequestReconfirmationService.name, {
        action: 'change-request-reconfirmation',
        outcome,
        orgId: job.orgId,
        verificationId: job.verificationId,
        reason,
        ...(job.attempt !== undefined ? { attempt: job.attempt } : {}),
      }),
    );
  }
}
