import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import {
  VERIFICATION_AUTOMATION_QUEUE_NAME,
  VerificationAutomationJobPayload,
  VerificationAutomationJobType,
} from './verification-automation.constants';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationSendService } from '../verification-core/verification-send.service';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import {
  ORDER_TAGGING_PORT,
  type OrderTaggingPort,
} from '../../shared/ports/order-tagging.port';
import { integrations } from '../../infrastructure/database/schema';
import {
  adjustForQuietHours,
  isInsideQuietHours,
} from '../../shared/utils/quiet-hours.util';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

const TERMINAL_OR_FINAL_STATUSES = [
  'confirmed',
  'canceled',
  'failed',
  'expired',
  'no_reply',
] as const;

@Processor(VERIFICATION_AUTOMATION_QUEUE_NAME, { concurrency: 5 })
@Injectable()
export class VerificationAutomationProcessor extends WorkerHost {
  private readonly logger = new Logger(VerificationAutomationProcessor.name);

  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly ordersRepo: OrdersRepository,
    private readonly verificationSendService: VerificationSendService,
    private readonly verificationHub: VerificationHubService,
    @Inject(ORDER_TAGGING_PORT)
    private readonly orderTaggingPort: OrderTaggingPort,
  ) {
    super();
  }

  async process(
    job: Job<VerificationAutomationJobPayload>,
    token?: string,
  ): Promise<void> {
    const { data, name } = job;
    this.logger.log(
      buildBackendLog(VerificationAutomationProcessor.name, {
        action: 'verification-automation-job-process',
        outcome: 'success',
        jobId: String(job.id),
        jobType: name,
        verificationId: data.verificationId,
        orgId: data.orgId,
      }),
    );

    switch (name as VerificationAutomationJobType) {
      case VerificationAutomationJobType.INITIAL_SEND:
        await this.handleInitialSend(job, token);
        return;
      case VerificationAutomationJobType.FOLLOW_UP:
        await this.handleFollowUp(job, token);
        return;
      case VerificationAutomationJobType.ESCALATE_NO_REPLY:
        await this.handleEscalateNoReply(job, token);
        return;
      default:
        this.logger.warn(
          buildBackendLog(VerificationAutomationProcessor.name, {
            action: 'verification-automation-job-process',
            outcome: 'skipped',
            jobId: String(job.id),
            jobType: name,
            verificationId: data.verificationId,
            orgId: data.orgId,
            reason: 'unhandled_job_type',
          }),
        );
        return;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // INITIAL SEND
  // ───────────────────────────────────────────────────────────────────────

  private async handleInitialSend(
    job: Job<VerificationAutomationJobPayload>,
    token?: string,
  ): Promise<void> {
    const ctx = await this.loadContext(job.data.verificationId);
    if (!ctx) return;

    if (!ctx.integration.isAutoVerifyEnabled) {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-initial-send',
          outcome: 'skipped',
          verificationId: ctx.verification.id,
          orgId: ctx.verification.orgId,
          reason: 'auto_verify_disabled',
        }),
      );
      await this.verificationsRepo.mergeMetadata(ctx.verification.id, {
        initial_send_skipped: 'auto_verify_disabled',
      });
      return;
    }

    if (ctx.verification.status !== 'pending') {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-initial-send',
          outcome: 'skipped',
          verificationId: ctx.verification.id,
          orgId: ctx.verification.orgId,
          status: ctx.verification.status,
          reason: 'status_not_pending',
        }),
      );
      return;
    }

    if (await this.delayIfQuietHours(job, ctx.integration, token)) return;

    const outcome = await this.verificationSendService.sendInitial(
      ctx.verification.id,
    );

    if (outcome.status === 'sent') {
      await this.verificationHub.scheduleFollowUpAndEscalation({
        verificationId: ctx.verification.id,
        orgId: ctx.verification.orgId,
        integration: ctx.integration,
        baselineSentAt: outcome.sentAt ? new Date(outcome.sentAt) : new Date(),
      });
    } else if (outcome.status === 'plan_limit_reached') {
      await this.verificationsRepo.updateByIdForOrg(
        ctx.verification.id,
        ctx.verification.orgId,
        {
          status: 'failed',
          metadata: {
            reason: 'plan_limit_reached',
            kind: 'initial',
          },
        },
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // FOLLOW-UP
  // ───────────────────────────────────────────────────────────────────────

  private async handleFollowUp(
    job: Job<VerificationAutomationJobPayload>,
    token?: string,
  ): Promise<void> {
    const ctx = await this.loadContext(job.data.verificationId);
    if (!ctx) return;

    const { verification, integration } = ctx;

    if (!integration.followUpEnabled) {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-follow-up',
          outcome: 'skipped',
          verificationId: verification.id,
          orgId: verification.orgId,
          reason: 'follow_up_disabled',
        }),
      );
      return;
    }

    if (this.isStatusTerminal(verification.status)) {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-follow-up',
          outcome: 'skipped',
          verificationId: verification.id,
          orgId: verification.orgId,
          status: verification.status,
          reason: 'status_terminal',
        }),
      );
      return;
    }

    if (verification.merchantCanceledAt) {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-follow-up',
          outcome: 'skipped',
          verificationId: verification.id,
          orgId: verification.orgId,
          reason: 'merchant_canceled',
        }),
      );
      return;
    }

    if ((verification.followUpAttempts ?? 0) > 0) {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-follow-up',
          outcome: 'skipped',
          verificationId: verification.id,
          orgId: verification.orgId,
          followUpAttempts: verification.followUpAttempts ?? 0,
          reason: 'already_attempted',
        }),
      );
      return;
    }

    if (await this.delayIfQuietHours(job, integration, token)) return;

    const outcome = await this.verificationSendService.sendFollowUp(
      verification.id,
    );

    if (outcome.status === 'sent') {
      await this.verificationsRepo.markFollowUpSent(
        verification.id,
        outcome.waMessageId!,
      );
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-follow-up',
          outcome: 'success',
          verificationId: verification.id,
          orgId: verification.orgId,
          wamid: outcome.waMessageId,
        }),
      );
    } else if (outcome.status === 'plan_limit_reached') {
      await this.verificationsRepo.mergeMetadata(verification.id, {
        follow_up_skipped: 'plan_limit_reached',
        follow_up_skipped_at: new Date().toISOString(),
      });
    } else if (outcome.status === 'failed') {
      await this.verificationsRepo.mergeMetadata(verification.id, {
        follow_up_failed: outcome.reason ?? 'unknown',
        follow_up_failed_at: new Date().toISOString(),
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // NO-REPLY ESCALATION
  // ───────────────────────────────────────────────────────────────────────

  private async handleEscalateNoReply(
    job: Job<VerificationAutomationJobPayload>,
    token?: string,
  ): Promise<void> {
    const ctx = await this.loadContext(job.data.verificationId);
    if (!ctx) return;

    const { verification, order, integration } = ctx;

    if (this.isStatusTerminal(verification.status)) {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-no-reply-escalate',
          outcome: 'skipped',
          verificationId: verification.id,
          orgId: verification.orgId,
          status: verification.status,
          reason: 'status_terminal',
        }),
      );
      return;
    }

    if (verification.merchantCanceledAt) {
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-no-reply-escalate',
          outcome: 'skipped',
          verificationId: verification.id,
          orgId: verification.orgId,
          reason: 'merchant_canceled',
        }),
      );
      return;
    }

    if (await this.delayIfQuietHours(job, integration, token)) return;

    // If follow-up is still pending, push escalation behind it.
    if (
      integration.followUpEnabled &&
      (verification.followUpAttempts ?? 0) === 0
    ) {
      const reschedule = new Date(Date.now() + 60_000);
      this.logger.log(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-no-reply-escalate',
          outcome: 'retry',
          verificationId: verification.id,
          orgId: verification.orgId,
          reason: 'follow_up_pending',
          rescheduleAt: reschedule.toISOString(),
        }),
      );
      if (!token) {
        this.logger.warn(
          buildBackendLog(VerificationAutomationProcessor.name, {
            action: 'verification-automation-no-reply-escalate',
            outcome: 'failure',
            verificationId: verification.id,
            orgId: verification.orgId,
            reason: 'missing_bullmq_token',
          }),
        );
        throw new Error('cannot_delay_without_token');
      }
      await job.moveToDelayed(reschedule.getTime(), token);
      throw new DelayedError();
    }

    await this.verificationsRepo.updateStatus(
      verification.id,
      'no_reply',
      undefined,
      undefined,
    );

    if (
      order.externalOrderId &&
      !order.externalOrderId.startsWith('akeed-test-') &&
      integration.platformStoreUrl
    ) {
      try {
        await this.orderTaggingPort.addOrderTag(
          integration,
          order.externalOrderId,
          'Akeed: No Reply',
        );
        this.logger.log(
          buildBackendLog(VerificationAutomationProcessor.name, {
            action: 'verification-automation-no-reply-tag-order',
            outcome: 'success',
            verificationId: verification.id,
            orgId: verification.orgId,
            shopDomain: integration.platformStoreUrl,
            orderId: order.externalOrderId,
            tag: 'Akeed: No Reply',
          }),
        );
      } catch (error) {
        this.logger.error(
          buildBackendLog(VerificationAutomationProcessor.name, {
            action: 'verification-automation-no-reply-tag-order',
            outcome: 'failure',
            verificationId: verification.id,
            orgId: verification.orgId,
            shopDomain: integration.platformStoreUrl,
            orderId: order.externalOrderId,
            tag: 'Akeed: No Reply',
            ...normalizeError(error),
          }),
        );
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────

  private async loadContext(verificationId: string): Promise<{
    verification: NonNullable<
      Awaited<ReturnType<VerificationsRepository['findById']>>
    >;
    order: NonNullable<Awaited<ReturnType<OrdersRepository['findById']>>>;
    integration: typeof integrations.$inferSelect;
  } | null> {
    const verification = await this.verificationsRepo.findById(verificationId);
    if (!verification) {
      this.logger.warn(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-context-load',
          outcome: 'skipped',
          verificationId,
          reason: 'verification_not_found',
        }),
      );
      return null;
    }

    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order) {
      this.logger.warn(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-context-load',
          outcome: 'skipped',
          verificationId,
          orgId: verification.orgId,
          orderId: verification.orderId,
          reason: 'order_not_found',
        }),
      );
      return null;
    }

    const integration =
      (order.integration as typeof integrations.$inferSelect | null) ?? null;
    if (!integration) {
      this.logger.warn(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-context-load',
          outcome: 'skipped',
          verificationId,
          orgId: verification.orgId,
          orderId: order.id,
          reason: 'integration_not_loaded',
        }),
      );
      return null;
    }

    return { verification, order, integration };
  }

  private isStatusTerminal(status: string | null | undefined): boolean {
    if (!status) return false;
    return TERMINAL_OR_FINAL_STATUSES.includes(
      status as (typeof TERMINAL_OR_FINAL_STATUSES)[number],
    );
  }

  /**
   * If quiet hours are currently active, move the BullMQ job to the next valid
   * timestamp and throw `DelayedError` so the worker treats the job as delayed
   * rather than completed. Returns `true` when the job was delayed.
   */
  private async delayIfQuietHours(
    job: Job<VerificationAutomationJobPayload>,
    integration: typeof integrations.$inferSelect,
    token?: string,
  ): Promise<boolean> {
    const now = new Date();
    const config = {
      enabled: integration.quietHoursEnabled,
      start: integration.quietHoursStart,
      end: integration.quietHoursEnd,
      timezone: integration.timezone,
    };

    if (!isInsideQuietHours(now, config)) return false;

    const nextDue = adjustForQuietHours(now, config);
    if (nextDue.getTime() <= now.getTime()) return false;

    this.logger.log(
      buildBackendLog(VerificationAutomationProcessor.name, {
        action: 'verification-automation-job-delay-quiet-hours',
        outcome: 'retry',
        jobId: String(job.id),
        verificationId: job.data.verificationId,
        orgId: job.data.orgId,
        dueAt: nextDue.toISOString(),
      }),
    );

    if (!token) {
      this.logger.warn(
        buildBackendLog(VerificationAutomationProcessor.name, {
          action: 'verification-automation-job-delay-quiet-hours',
          outcome: 'failure',
          jobId: String(job.id),
          verificationId: job.data.verificationId,
          orgId: job.data.orgId,
          reason: 'missing_bullmq_token',
        }),
      );
      return false;
    }

    await job.moveToDelayed(nextDue.getTime(), token);
    throw new DelayedError();
  }
}
