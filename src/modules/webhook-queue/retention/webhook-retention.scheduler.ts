import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  WEBHOOK_RETENTION_EVERY_MS,
  WEBHOOK_RETENTION_JOB,
  WEBHOOK_RETENTION_QUEUE,
  WEBHOOK_RETENTION_SCHEDULER,
} from './webhook-retention.constants';

/**
 * Hourly. The fixed scheduler id makes Redis keep one schedule however many
 * instances start, and a failed run is not retried: the next one is an hour
 * away. `WEBHOOK_RETENTION_ENABLED=false` removes the schedule.
 */
@Injectable()
export class WebhookRetentionScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookRetentionScheduler.name);

  constructor(
    @InjectQueue(WEBHOOK_RETENTION_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  enabled(): boolean {
    return this.config.get<string>('WEBHOOK_RETENTION_ENABLED') !== 'false';
  }

  async ensure(): Promise<void> {
    const enabled = this.enabled();
    try {
      if (enabled)
        await this.queue.upsertJobScheduler(
          WEBHOOK_RETENTION_SCHEDULER,
          { every: WEBHOOK_RETENTION_EVERY_MS },
          {
            name: WEBHOOK_RETENTION_JOB,
            data: {},
            opts: {
              attempts: 1,
              removeOnComplete: { age: 24 * 60 * 60, count: 200 },
              removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
            },
          },
        );
      else await this.queue.removeJobScheduler(WEBHOOK_RETENTION_SCHEDULER);
      this.logger.log(
        buildBackendLog(WebhookRetentionScheduler.name, {
          action: 'webhook-retention-scheduler-ensure',
          outcome: 'success',
          enabled,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(WebhookRetentionScheduler.name, {
          action: 'webhook-retention-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
