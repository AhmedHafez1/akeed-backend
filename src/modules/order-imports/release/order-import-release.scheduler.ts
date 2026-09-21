import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { OrderImportReleaseRepository } from '../../../infrastructure/database/repositories/order-import-release.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  ORDER_IMPORT_EXPIRE_EVERY_MS,
  ORDER_IMPORT_EXPIRE_JOB,
  ORDER_IMPORT_EXPIRE_SCHEDULER,
  ORDER_IMPORT_QUEUE,
  ORDER_IMPORT_RELEASE_JOB,
  orderImportReleaseSchedulerId,
} from '../order-import-queue.constants';
import { RELEASE_TICK_MS } from './release-policy';

/**
 * Ticks are not retried: the next one, 30 s later, re-reads everything and is
 * the retry. Completed ticks are dropped quickly so an org releasing for hours
 * does not leave thousands of finished jobs in Redis.
 */
const TICK_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 60 * 60, count: 100 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
};

/**
 * Owns the BullMQ schedulers of the paced release: one repeatable
 * `import.release` job per organization with releasing batches, and the
 * hourly `import.expire` job.
 */
@Injectable()
export class OrderImportReleaseScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderImportReleaseScheduler.name);

  constructor(
    @InjectQueue(ORDER_IMPORT_QUEUE) private readonly queue: Queue,
    private readonly releases: OrderImportReleaseRepository,
  ) {}

  /**
   * A worker restart must not strand a releasing batch: every organization
   * that still has one gets its scheduler back. Upserting is idempotent.
   */
  onApplicationBootstrap(): void {
    void this.restore();
  }

  /** Make sure the organization's release ticks are running. */
  async ensure(orgId: string): Promise<void> {
    await this.queue.upsertJobScheduler(
      orderImportReleaseSchedulerId(orgId),
      { every: RELEASE_TICK_MS },
      {
        name: ORDER_IMPORT_RELEASE_JOB,
        data: { orgId },
        opts: TICK_JOB_OPTIONS,
      },
    );
  }

  /** Stop ticking once the organization has nothing releasing. */
  async remove(orgId: string): Promise<void> {
    await this.queue.removeJobScheduler(orderImportReleaseSchedulerId(orgId));
    this.logger.log(
      buildBackendLog(OrderImportReleaseScheduler.name, {
        action: 'order-import-release-scheduler-remove',
        outcome: 'success',
        orgId,
      }),
    );
  }

  private async restore(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        ORDER_IMPORT_EXPIRE_SCHEDULER,
        { every: ORDER_IMPORT_EXPIRE_EVERY_MS },
        { name: ORDER_IMPORT_EXPIRE_JOB, data: {}, opts: TICK_JOB_OPTIONS },
      );
      const orgIds = await this.releases.listOrgsWithReleasing();
      for (const orgId of orgIds) await this.ensure(orgId);
      this.logger.log(
        buildBackendLog(OrderImportReleaseScheduler.name, {
          action: 'order-import-release-scheduler-restore',
          outcome: 'success',
          organizations: orgIds.length,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(OrderImportReleaseScheduler.name, {
          action: 'order-import-release-scheduler-restore',
          outcome: 'failure',
          errorCode: 'queue_unavailable',
          ...normalizeError(error),
        }),
      );
    }
  }
}
