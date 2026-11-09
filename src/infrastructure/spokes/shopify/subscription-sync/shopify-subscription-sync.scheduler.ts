import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JobsOptions, Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import {
  SHOPIFY_SUBSCRIPTION_SYNC_ENABLED_KEY,
  SHOPIFY_SUBSCRIPTION_SYNC_EVERY_MS,
  SHOPIFY_SUBSCRIPTION_SYNC_JOB,
  SHOPIFY_SUBSCRIPTION_SYNC_QUEUE,
  SHOPIFY_SUBSCRIPTION_SYNC_SCHEDULER,
  isShopifySubscriptionSyncEnabled,
} from './shopify-subscription-sync.constants';

/** A run is not retried: the next one is a day away and repeats every check. */
const SYNC_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50 },
  removeOnFail: { age: 30 * 24 * 60 * 60, count: 100 },
};

/** Owns the daily reconciliation; switching it off removes the schedule. */
@Injectable()
export class ShopifySubscriptionSyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ShopifySubscriptionSyncScheduler.name);

  constructor(
    @InjectQueue(SHOPIFY_SUBSCRIPTION_SYNC_QUEUE)
    private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    const enabled = isShopifySubscriptionSyncEnabled(
      this.config.get<string>(SHOPIFY_SUBSCRIPTION_SYNC_ENABLED_KEY),
    );
    try {
      if (enabled) {
        await this.queue.upsertJobScheduler(
          SHOPIFY_SUBSCRIPTION_SYNC_SCHEDULER,
          { every: SHOPIFY_SUBSCRIPTION_SYNC_EVERY_MS },
          {
            name: SHOPIFY_SUBSCRIPTION_SYNC_JOB,
            data: {},
            opts: SYNC_JOB_OPTIONS,
          },
        );
      } else {
        await this.queue.removeJobScheduler(
          SHOPIFY_SUBSCRIPTION_SYNC_SCHEDULER,
        );
      }
      this.logger.log(
        buildBackendLog(ShopifySubscriptionSyncScheduler.name, {
          action: 'shopify-subscription-sync-scheduler-ensure',
          outcome: 'success',
          enabled,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(ShopifySubscriptionSyncScheduler.name, {
          action: 'shopify-subscription-sync-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
