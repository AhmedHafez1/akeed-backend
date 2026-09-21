import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';
import {
  ORDER_IMPORT_COMMIT_JOB,
  ORDER_IMPORT_QUEUE,
  orderImportCommitJobId,
  type OrderImportCommitJob,
} from './order-import-queue.constants';

@Injectable()
export class OrderImportCommitProducer {
  private readonly logger = new Logger(OrderImportCommitProducer.name);

  constructor(
    @InjectQueue(ORDER_IMPORT_QUEUE)
    private readonly queue: Queue<OrderImportCommitJob>,
  ) {}

  /**
   * Queue the commit for a batch that has just been claimed.
   *
   * Adding a job whose id is already present is silently ignored by BullMQ,
   * which is exactly the behaviour a replayed request wants: the batch is
   * already `committing` and its job is already running.
   */
  async enqueue(job: OrderImportCommitJob): Promise<void> {
    await this.queue.add(ORDER_IMPORT_COMMIT_JOB, job, {
      ...DEFAULT_QUEUE_JOB_OPTIONS,
      jobId: orderImportCommitJobId(job.batchId),
    });
    this.logger.log(
      buildBackendLog(OrderImportCommitProducer.name, {
        action: 'order-import-commit-enqueue',
        outcome: 'success',
        orgId: job.orgId,
        batchId: job.batchId,
      }),
    );
  }
}
