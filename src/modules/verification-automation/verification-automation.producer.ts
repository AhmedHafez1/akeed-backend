import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  VERIFICATION_AUTOMATION_QUEUE_NAME,
  VerificationAutomationJobPayload,
  VerificationAutomationJobType,
} from './verification-automation.constants';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';

interface ScheduleParams {
  verificationId: string;
  orgId: string;
  dueAt: Date;
}

interface ReplyFollowUpParams {
  verificationId: string;
  orgId: string;
  /** The provider's time of the customer's message, ISO. */
  repliedAt: string;
  intent?: 'confirmed' | 'canceled';
}

/**
 * Producer for the verification-automation queue.
 *
 * All scheduling helpers compute `delay = max(0, dueAt - now)` and use
 * deterministic job IDs so duplicate scheduling is naturally idempotent
 * (BullMQ ignores `add` calls whose `jobId` already exists, unless the
 * existing job has finished and been removed).
 */
@Injectable()
export class VerificationAutomationProducer {
  private readonly logger = new Logger(VerificationAutomationProducer.name);

  constructor(
    @InjectQueue(VERIFICATION_AUTOMATION_QUEUE_NAME)
    private readonly queue: Queue<VerificationAutomationJobPayload>,
  ) {}

  async enqueueInitialSend(params: ScheduleParams): Promise<void> {
    await this.enqueue(
      params,
      VerificationAutomationJobType.INITIAL_SEND,
      'initial',
    );
  }

  async enqueueFollowUp(params: ScheduleParams): Promise<void> {
    await this.enqueue(
      params,
      VerificationAutomationJobType.FOLLOW_UP,
      'follow-up-1',
    );
  }

  async enqueueNoReplyEscalation(params: ScheduleParams): Promise<void> {
    await this.enqueue(
      params,
      VerificationAutomationJobType.ESCALATE_NO_REPLY,
      'no-reply',
    );
  }

  /**
   * The acknowledgment and the nudge (US-08-07 b, c): due now, attempted
   * once. A deterministic job id per verification makes a replayed webhook a
   * no-op; the row claimed by the worker is what guarantees one message.
   */
  async enqueueAcknowledgment(params: ReplyFollowUpParams): Promise<void> {
    await this.enqueueReplyFollowUp(
      params,
      VerificationAutomationJobType.ACKNOWLEDGMENT,
      'acknowledgment',
    );
  }

  async enqueueUnresolvedReplyNudge(
    params: ReplyFollowUpParams,
  ): Promise<void> {
    await this.enqueueReplyFollowUp(
      params,
      VerificationAutomationJobType.UNRESOLVED_REPLY_NUDGE,
      'nudge',
    );
  }

  private async enqueueReplyFollowUp(
    params: ReplyFollowUpParams,
    jobType: VerificationAutomationJobType,
    suffix: string,
  ): Promise<void> {
    const jobId = `verification-${params.verificationId}-${suffix}`;
    const payload: VerificationAutomationJobPayload = {
      verificationId: params.verificationId,
      orgId: params.orgId,
      scheduledAt: new Date().toISOString(),
      reply: {
        repliedAt: params.repliedAt,
        ...(params.intent ? { intent: params.intent } : {}),
      },
    };
    await this.queue.add(jobType, payload, {
      ...DEFAULT_QUEUE_JOB_OPTIONS,
      jobId,
      attempts: 1,
    });
    this.logger.log(
      buildBackendLog('VerificationAutomationProducer', {
        action: 'enqueue',
        outcome: 'success',
        jobType,
        verificationId: params.verificationId,
        delayMs: 0,
        jobId,
      }),
    );
  }

  private async enqueue(
    params: ScheduleParams,
    jobType: VerificationAutomationJobType,
    suffix: string,
  ): Promise<void> {
    const now = Date.now();
    const delay = Math.max(0, params.dueAt.getTime() - now);
    const jobId = `verification-${params.verificationId}-${suffix}`;

    const payload: VerificationAutomationJobPayload = {
      verificationId: params.verificationId,
      orgId: params.orgId,
      scheduledAt: params.dueAt.toISOString(),
    };

    await this.queue.add(jobType, payload, {
      jobId,
      delay,
      ...DEFAULT_QUEUE_JOB_OPTIONS,
    });

    this.logger.log(
      buildBackendLog('VerificationAutomationProducer', {
        action: 'enqueue',
        outcome: 'success',
        jobType,
        verificationId: params.verificationId,
        delayMs: delay,
        jobId,
      }),
    );
  }
}
