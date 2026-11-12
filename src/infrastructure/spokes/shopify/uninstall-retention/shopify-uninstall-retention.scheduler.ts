import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import {
  SHOPIFY_UNINSTALL_RETENTION_EVERY_MS,
  SHOPIFY_UNINSTALL_RETENTION_JOB,
  SHOPIFY_UNINSTALL_RETENTION_QUEUE,
  SHOPIFY_UNINSTALL_RETENTION_SCHEDULER,
} from './shopify-uninstall-retention.constants';

/**
 * Every 15 minutes, so a store is deleted at most 15 minutes after its
 * 48-hour window closes. There is no switch: this is Shopify compliance. The
 * fixed scheduler id keeps one schedule however many instances start, and a
 * failed run is not retried; the next one repeats every check.
 */
@Injectable()
export class ShopifyUninstallRetentionScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ShopifyUninstallRetentionScheduler.name);

  constructor(
    @InjectQueue(SHOPIFY_UNINSTALL_RETENTION_QUEUE)
    private readonly queue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        SHOPIFY_UNINSTALL_RETENTION_SCHEDULER,
        { every: SHOPIFY_UNINSTALL_RETENTION_EVERY_MS },
        {
          name: SHOPIFY_UNINSTALL_RETENTION_JOB,
          data: {},
          opts: {
            attempts: 1,
            removeOnComplete: { age: 24 * 60 * 60, count: 200 },
            removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
          },
        },
      );
      this.logger.log(
        buildBackendLog(ShopifyUninstallRetentionScheduler.name, {
          action: 'shopify-uninstall-retention-scheduler-ensure',
          outcome: 'success',
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(ShopifyUninstallRetentionScheduler.name, {
          action: 'shopify-uninstall-retention-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
