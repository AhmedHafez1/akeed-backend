import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { OrderImportCommitProcessor } from './order-import-commit.processor';
import {
  ORDER_IMPORT_COMMIT_JOB,
  ORDER_IMPORT_EXPIRE_JOB,
  ORDER_IMPORT_PURGE_JOB,
  ORDER_IMPORT_QUEUE,
  ORDER_IMPORT_RELEASE_JOB,
  type OrderImportCommitJob,
  type OrderImportReleaseJob,
} from './order-import-queue.constants';
import { OrderImportExpireService } from './release/order-import-expire.service';
import { OrderImportPurgeService } from './release/order-import-purge.service';
import { OrderImportReleaseTickService } from './release/order-import-release-tick.service';

/**
 * The one worker on the `order-import` queue, routing each job by name. The
 * queue stays separate from `webhook-processing`, so neither a long commit
 * nor a release tick ever sits in front of a manual or Shopify order.
 */
@Processor(ORDER_IMPORT_QUEUE, { concurrency: 2 })
@Injectable()
export class OrderImportProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderImportProcessor.name);

  constructor(
    private readonly commit: OrderImportCommitProcessor,
    private readonly release: OrderImportReleaseTickService,
    private readonly expire: OrderImportExpireService,
    private readonly purge: OrderImportPurgeService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case ORDER_IMPORT_RELEASE_JOB:
        await this.release.tick((job.data as OrderImportReleaseJob).orgId);
        return;
      case ORDER_IMPORT_EXPIRE_JOB:
        await this.expire.run();
        return;
      case ORDER_IMPORT_PURGE_JOB:
        await this.purge.run();
        return;
      case ORDER_IMPORT_COMMIT_JOB:
      default:
        await this.commit.process(job as Job<OrderImportCommitJob>);
    }
  }

  /** Only a commit has terminal-failure handling; ticks simply run again. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job) return;
    if (job.name === ORDER_IMPORT_COMMIT_JOB) {
      await this.commit.onFailed(job as Job<OrderImportCommitJob>, error);
      return;
    }
    this.logger.error(
      buildBackendLog(OrderImportProcessor.name, {
        action: job.name,
        outcome: 'failure',
        orgId: (job.data as Partial<OrderImportReleaseJob>)?.orgId,
        ...normalizeError(error),
      }),
    );
  }
}
