import { Injectable, Logger } from '@nestjs/common';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  VERIFICATION_AUTOMATION_QUEUE_NAME,
  VerificationAutomationJobPayload,
  VerificationAutomationJobType,
} from './verification-automation.constants';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';

/** Job id suffixes of the reminder and the no-reply escalation. */
const REMINDER_JOB_SUFFIXES = ['follow-up-1', 'no-reply'] as const;

/** Job states in which a job has not started and can be removed. */
const CANCELLABLE_JOB_STATES = new Set<string>([
  'delayed',
  'waiting',
  'prioritized',
]);

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
   * Removes the reminder and the no-reply escalation of one verification while
   * they are still waiting to run, and returns how many were removed.
   *
   * Best effort: a job already running or finished is left alone, and a queue
   * error is logged and swallowed. The processor re-checks the verification's
   * status before acting, so a job that survives here still does nothing.
   */
  async cancelPendingReminders(params: {
    verificationId: string;
    orgId: string;
  }): Promise<number> {
    let removed = 0;
    for (const suffix of REMINDER_JOB_SUFFIXES) {
      const jobId = `verification-${params.verificationId}-${suffix}`;
      try {
        const job = await this.queue.getJob(jobId);
        if (!job) continue;
        const state = await job.getState();
        if (!CANCELLABLE_JOB_STATES.has(state)) continue;
        await job.remove();
        removed += 1;
      } catch (error) {
        this.logger.warn(
          buildBackendLog('VerificationAutomationProducer', {
            action: 'cancel-reminder',
            outcome: 'failure',
            orgId: params.orgId,
            verificationId: params.verificationId,
            jobId,
            ...normalizeError(error),
          }),
        );
      }
    }
    this.logger.log(
      buildBackendLog('VerificationAutomationProducer', {
        action: 'cancel-reminder',
        outcome: 'success',
        orgId: params.orgId,
        verificationId: params.verificationId,
        removed,
      }),
    );
    return removed;
  }

  /**
   * The acknowledgment and the nudge: due now, attempted
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
