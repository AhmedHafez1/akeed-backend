import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';
import {
  AUTO_CANCELLATION_CONFIRM_JOB,
  AUTO_CANCELLATION_EXECUTE_JOB,
  AUTO_CANCELLATION_QUEUE,
  autoCancellationJobId,
  type AutoCancellationJobPayload,
} from './auto-cancellation.constants';

/**
 * Schedules work for one cancellation row. Called after the row was written
 * and never throws: a lost job is picked up by the sweep.
 */
@Injectable()
export class AutoCancellationProducer {
  private readonly logger = new Logger(AutoCancellationProducer.name);

  constructor(
    @InjectQueue(AUTO_CANCELLATION_QUEUE)
    private readonly queue: Queue<AutoCancellationJobPayload>,
  ) {}

  async enqueueExecute(autoCancellationId: string, at: Date): Promise<void> {
    await this.add(AUTO_CANCELLATION_EXECUTE_JOB, autoCancellationId, at);
  }

  async enqueueConfirm(autoCancellationId: string, at: Date): Promise<void> {
    await this.add(AUTO_CANCELLATION_CONFIRM_JOB, autoCancellationId, at);
  }

  private async add(
    name: string,
    autoCancellationId: string,
    at: Date,
  ): Promise<void> {
    const kind = name === AUTO_CANCELLATION_CONFIRM_JOB ? 'confirm' : 'execute';
    try {
      await this.queue.add(
        name,
        { autoCancellationId },
        {
          ...DEFAULT_QUEUE_JOB_OPTIONS,
          jobId: autoCancellationJobId(autoCancellationId, kind, at),
          delay: Math.max(0, at.getTime() - Date.now()),
        },
      );
    } catch (error) {
      this.logger.warn(
        buildBackendLog(AutoCancellationProducer.name, {
          action: 'auto-cancellation-enqueue',
          outcome: 'failure',
          autoCancellationId,
          jobType: name,
          ...normalizeError(error),
        }),
      );
    }
  }
}
