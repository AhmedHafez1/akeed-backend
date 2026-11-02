import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  META_WEBHOOK_PURGE_EVERY_MS,
  META_WEBHOOK_PURGE_JOB,
  META_WEBHOOK_PURGE_SCHEDULER,
  META_WEBHOOK_QUEUE,
  META_WEBHOOK_SWEEP_EVERY_MS,
  META_WEBHOOK_SWEEP_JOB,
  META_WEBHOOK_SWEEP_SCHEDULER,
} from './meta-webhook-queue.constants';

/** Neither is retried: the next one is due soon. */
const REPEATING_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 200 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
};

/**
 * Owns the repeating sweep and purge. They run whichever way the switch is
 * set: events stored before switching back still have to drain.
 */
@Injectable()
export class MetaWebhookEventsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MetaWebhookEventsScheduler.name);

  constructor(@InjectQueue(META_WEBHOOK_QUEUE) private readonly queue: Queue) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        META_WEBHOOK_SWEEP_SCHEDULER,
        { every: META_WEBHOOK_SWEEP_EVERY_MS },
        {
          name: META_WEBHOOK_SWEEP_JOB,
          data: {},
          opts: REPEATING_JOB_OPTIONS,
        },
      );
      await this.queue.upsertJobScheduler(
        META_WEBHOOK_PURGE_SCHEDULER,
        { every: META_WEBHOOK_PURGE_EVERY_MS },
        {
          name: META_WEBHOOK_PURGE_JOB,
          data: {},
          opts: REPEATING_JOB_OPTIONS,
        },
      );
      this.logger.log(
        buildBackendLog(MetaWebhookEventsScheduler.name, {
          action: 'meta-webhook-scheduler-ensure',
          outcome: 'success',
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(MetaWebhookEventsScheduler.name, {
          action: 'meta-webhook-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
