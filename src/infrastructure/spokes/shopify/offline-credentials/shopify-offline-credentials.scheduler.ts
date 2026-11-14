import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JobsOptions, Queue } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import {
  isTokenMigrationEnabled,
  isTokenRefreshJobEnabled,
  SHOPIFY_OFFLINE_CREDENTIALS_EVERY_MS,
  SHOPIFY_OFFLINE_CREDENTIALS_JOB,
  SHOPIFY_OFFLINE_CREDENTIALS_QUEUE,
  SHOPIFY_OFFLINE_CREDENTIALS_SCHEDULER,
  SHOPIFY_TOKEN_MIGRATION_ENABLED_KEY,
  SHOPIFY_TOKEN_REFRESH_JOB_ENABLED_KEY,
} from './shopify-offline-credentials.constants';

/** A run is not retried: the next one is 15 minutes away and repeats it. */
const RUN_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 60 * 60, count: 50 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 100 },
};

/** Schedules the run while either phase is on; both off removes it. */
@Injectable()
export class ShopifyOfflineCredentialsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ShopifyOfflineCredentialsScheduler.name);

  constructor(
    @InjectQueue(SHOPIFY_OFFLINE_CREDENTIALS_QUEUE)
    private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensure();
  }

  async ensure(): Promise<void> {
    const migration = isTokenMigrationEnabled(
      this.config.get<string>(SHOPIFY_TOKEN_MIGRATION_ENABLED_KEY),
    );
    const keepAlive = isTokenRefreshJobEnabled(
      this.config.get<string>(SHOPIFY_TOKEN_REFRESH_JOB_ENABLED_KEY),
    );
    try {
      if (migration || keepAlive) {
        await this.queue.upsertJobScheduler(
          SHOPIFY_OFFLINE_CREDENTIALS_SCHEDULER,
          { every: SHOPIFY_OFFLINE_CREDENTIALS_EVERY_MS },
          {
            name: SHOPIFY_OFFLINE_CREDENTIALS_JOB,
            data: {},
            opts: RUN_JOB_OPTIONS,
          },
        );
      } else {
        await this.queue.removeJobScheduler(
          SHOPIFY_OFFLINE_CREDENTIALS_SCHEDULER,
        );
      }
      this.logger.log(
        buildBackendLog(ShopifyOfflineCredentialsScheduler.name, {
          action: 'shopify-offline-credentials-scheduler-ensure',
          outcome: 'success',
          migration,
          keepAlive,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(ShopifyOfflineCredentialsScheduler.name, {
          action: 'shopify-offline-credentials-scheduler-ensure',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
