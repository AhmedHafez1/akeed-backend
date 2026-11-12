import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import {
  SHOPIFY_UNINSTALL_RETENTION_JOB,
  SHOPIFY_UNINSTALL_RETENTION_QUEUE,
} from './shopify-uninstall-retention.constants';
import { ShopifyUninstallRetentionService } from './shopify-uninstall-retention.service';

@Processor(SHOPIFY_UNINSTALL_RETENTION_QUEUE, { concurrency: 1 })
@Injectable()
export class ShopifyUninstallRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(ShopifyUninstallRetentionProcessor.name);

  constructor(private readonly retention: ShopifyUninstallRetentionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === SHOPIFY_UNINSTALL_RETENTION_JOB) {
      await this.retention.run();
      return;
    }
    this.logger.warn(
      buildBackendLog(ShopifyUninstallRetentionProcessor.name, {
        action: 'shopify-uninstall-retention-job',
        outcome: 'skipped',
        reason: 'unknown_job',
        jobName: job.name,
      }),
    );
  }
}
