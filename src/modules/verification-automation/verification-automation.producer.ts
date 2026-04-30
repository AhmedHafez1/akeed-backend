import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  VERIFICATION_AUTOMATION_QUEUE_NAME,
  VerificationAutomationJobPayload,
  VerificationAutomationJobType,
} from './verification-automation.constants';

interface ScheduleParams {
  verificationId: string;
  orgId: string;
  dueAt: Date;
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
      'follow-up:1',
    );
  }

  async enqueueNoReplyEscalation(params: ScheduleParams): Promise<void> {
    await this.enqueue(
      params,
      VerificationAutomationJobType.ESCALATE_NO_REPLY,
      'no-reply',
    );
  }

  private async enqueue(
    params: ScheduleParams,
    jobType: VerificationAutomationJobType,
    suffix: string,
  ): Promise<void> {
    const now = Date.now();
    const delay = Math.max(0, params.dueAt.getTime() - now);
    const jobId = `verification:${params.verificationId}:${suffix}`;

    const payload: VerificationAutomationJobPayload = {
      verificationId: params.verificationId,
      orgId: params.orgId,
      scheduledAt: params.dueAt.toISOString(),
    };

    await this.queue.add(jobType, payload, {
      jobId,
      delay,
      attempts: 5,
      backoff: { type: 'exponential', delay: 3_000 },
      removeOnComplete: { age: 7 * 24 * 3_600, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 3_600, count: 50_000 },
    });

    this.logger.log(
      `Enqueued ${jobType} for verification ${params.verificationId} (delay=${delay}ms, jobId=${jobId})`,
    );
  }
}
