import { Injectable, Logger } from '@nestjs/common';
import { OrderImportsRepository } from '../../../infrastructure/database/repositories/order-imports.repository';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { ORDER_IMPORT_RETENTION_DAYS } from '../order-import-queue.constants';

/** Rows or drafts handled per statement; the loop continues while it is full. */
export const ORDER_IMPORT_PURGE_CHUNK = 1_000;
const MAX_PASSES = 500;
const DAY_MS = 24 * 60 * 60_000;

/**
 * The daily `import.purge` job (US-04.6-09 AC4): the only retention path for
 * bulk import. Expired drafts are deleted with their rows, and committed rows
 * lose their customer data after 90 days while keeping outcome, issues, order
 * link and row number. Each statement is bounded and selects only what is
 * still due, so a second run on the same day does nothing.
 */
@Injectable()
export class OrderImportPurgeService {
  private readonly logger = new Logger(OrderImportPurgeService.name);

  constructor(private readonly repository: OrderImportsRepository) {}

  async run(
    now = new Date(),
  ): Promise<{ draftsDeleted: number; rowsPurged: number }> {
    const startedAt = Date.now();
    const draftsDeleted = await this.drain(() =>
      this.repository.deleteExpiredDrafts(now, ORDER_IMPORT_PURGE_CHUNK),
    );
    const cutoff = new Date(
      now.getTime() - ORDER_IMPORT_RETENTION_DAYS * DAY_MS,
    );
    const rowsPurged = await this.drain(() =>
      this.repository.purgeCommittedRows(cutoff, ORDER_IMPORT_PURGE_CHUNK),
    );
    this.logger.log(
      buildBackendLog(OrderImportPurgeService.name, {
        action: 'order-import-purge',
        outcome: 'success',
        draftsDeleted,
        rowsPurged,
        durationMs: Date.now() - startedAt,
      }),
    );
    return { draftsDeleted, rowsPurged };
  }

  private async drain(pass: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let index = 0; index < MAX_PASSES; index++) {
      const handled = await pass();
      total += handled;
      if (handled < ORDER_IMPORT_PURGE_CHUNK) break;
    }
    return total;
  }
}
