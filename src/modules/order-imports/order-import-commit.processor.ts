import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import {
  OrderImportsRepository,
  type CommitRowLink,
} from '../../infrastructure/database/repositories/order-imports.repository';
import { readBulkImportConfig } from '../../shared/config/bulk-import.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { FileImportChannelAdapter } from './file-import.channel-adapter';
import type { OrderImportCommitJob } from './order-import-queue.constants';
import type { NormalizedImportOrder } from './validation/row-validator';

/** Rows per acceptance call; matches the repository's per-chunk transaction. */
const COMMIT_CHUNK = 200;

/**
 * Runs `import.commit` jobs. `OrderImportProcessor` owns the queue worker and
 * routes each job here by name.
 */
@Injectable()
export class OrderImportCommitProcessor {
  private readonly logger = new Logger(OrderImportCommitProcessor.name);

  constructor(
    private readonly repository: OrderImportsRepository,
    private readonly ingestion: StandaloneOrderIngestionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create every ready row's held order, in row order, a chunk at a time.
   *
   * Resumable by construction: each pass reads only rows that still have no
   * `order_id`, so a worker that dies mid-batch simply continues where it
   * stopped, and a row whose event already exists is re-linked rather than
   * created again. Nothing here dispatches; that is `POST /start`.
   */
  async process(job: Job<OrderImportCommitJob>): Promise<void> {
    const { batchId, orgId } = job.data;
    const startedAt = Date.now();

    const batch = await this.repository.findBatchForCommit(orgId, batchId);
    if (!batch || batch.status !== 'committing') {
      // Already finished, failed or discarded: a retry of a job whose work is
      // done must not re-open it.
      this.logger.log(
        buildBackendLog(OrderImportCommitProcessor.name, {
          action: 'order-import-commit-skip',
          outcome: 'success',
          orgId,
          batchId,
          reason: batch ? batch.status : 'batch_missing',
        }),
      );
      return;
    }

    const ctx = {
      orgId,
      source: {
        id: batch.integrationId,
        platformStoreUrl: batch.platformStoreUrl,
      },
    };

    let imported = 0;
    let alreadyImported = 0;
    let afterRowNumber = 0;
    for (;;) {
      const rows = await this.repository.listRowsForCommit({
        orgId,
        batchId,
        afterRowNumber,
        limit: COMMIT_CHUNK,
      });
      if (rows.length === 0) break;

      const chunkStartedAt = Date.now();
      const results = await this.ingestion.acceptMany(
        ctx,
        rows.map((row) =>
          FileImportChannelAdapter.toAcceptManyInput(
            {
              rowNumber: row.rowNumber,
              normalized: normalizedOrder(row.normalized),
              dedupeKey: row.dedupeKey,
            },
            { id: batchId, shortCode: batch.shortCode },
          ),
        ),
        { channel: 'bulk_import', hold: { groupId: batchId } },
      );

      const links: CommitRowLink[] = [];
      const losers: number[] = [];
      results.forEach((result, index) => {
        const rowNumber = rows[index].rowNumber;
        if (result.status === 'accepted') {
          links.push({
            rowNumber,
            orderId: result.orderId,
            eventId: result.eventId,
          });
        } else {
          losers.push(rowNumber);
        }
      });

      await this.repository.writeCommitChunk({
        orgId,
        batchId,
        imported: links,
        alreadyImported: losers,
        now: new Date(),
      });

      imported += links.length;
      alreadyImported += losers.length;
      afterRowNumber = rows[rows.length - 1].rowNumber;

      this.logger.log(
        buildBackendLog(OrderImportCommitProcessor.name, {
          action: 'order-import-commit-chunk',
          outcome: 'success',
          orgId,
          batchId,
          rows: rows.length,
          imported: links.length,
          alreadyImported: losers.length,
          durationMs: Date.now() - chunkStartedAt,
        }),
      );
    }

    await this.repository.finishCommit({
      orgId,
      batchId,
      now: new Date(),
      startWindowHours: readBulkImportConfig(this.config).startWindowHours,
    });

    this.logger.log(
      buildBackendLog(OrderImportCommitProcessor.name, {
        action: 'order-import-commit',
        outcome: 'success',
        orgId,
        batchId,
        imported,
        alreadyImported,
        durationMs: Date.now() - startedAt,
      }),
    );
  }

  /**
   * The batch only fails once BullMQ is out of attempts.
   *
   * `failed` fires on every attempt, so an early return here is what keeps a
   * single retryable database blip from ending an import the next attempt
   * would have finished. Rows already imported stay held and startable.
   */
  async onFailed(
    job: Job<OrderImportCommitJob> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 5;
    const terminal = job.attemptsMade >= attempts;
    this.logger.error(
      buildBackendLog(OrderImportCommitProcessor.name, {
        action: 'order-import-commit',
        outcome: 'failure',
        orgId: job.data.orgId,
        batchId: job.data.batchId,
        attempt: job.attemptsMade,
        attempts,
        terminal,
        ...normalizeError(error),
      }),
    );
    if (!terminal) return;
    await this.repository.failCommit({
      orgId: job.data.orgId,
      batchId: job.data.batchId,
      now: new Date(),
    });
  }
}

/**
 * `normalized` is stored as free-form jsonb; the adapter needs the shape row
 * validation wrote. `paymentMethod` is the only always-present field.
 */
function normalizedOrder(
  stored: Record<string, string>,
): NormalizedImportOrder {
  return { paymentMethod: '', ...stored };
}
