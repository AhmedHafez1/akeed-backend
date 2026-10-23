import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  AUTO_CANCELLATION_QUEUE,
  AUTO_CANCELLATION_SWEEP_EVERY_MS,
  AUTO_CANCELLATION_SWEEP_JOB,
  AUTO_CANCELLATION_SWEEP_SCHEDULER,
} from './auto-cancellation.constants';

/** A sweep is not retried: the next one is minutes away. */
const SWEEP_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 200 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
};

/**
 * Owns the repeating sweep. It always runs: with no store using automatic
 * cancellation it finds no rows, and each row re-reads its store's setting.
 */
@Injectable()
export class AutoCancellationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(AutoCancellationScheduler.name);

  constructor(
    @InjectQueue(AUTO_CANCELLATION_QUEUE) private readonly queue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        AUTO_CANCELLATION_SWEEP_SCHEDULER,
        { every: AUTO_CANCELLATION_SWEEP_EVERY_MS },
        {
          name: AUTO_CANCELLATION_SWEEP_JOB,
          data: {},
          opts: SWEEP_JOB_OPTIONS,
        },
      );
      this.logger.log(
        buildBackendLog(AutoCancellationScheduler.name, {
          action: 'auto-cancellation-scheduler-ensure',
          outcome: 'success',
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(AutoCancellationScheduler.name, {
          action: 'auto-cancellation-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
