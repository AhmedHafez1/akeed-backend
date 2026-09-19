import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { orderImportBatches, orderImportRows } from '../schema';

type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Rows are written in chunks so one statement stays well under parameter limits. */
export const ORDER_IMPORT_ROW_CHUNK = 500;
const SHORT_CODE_ATTEMPTS = 5;

export interface OpenDraftSummary {
  batchId: string;
  fileName: string;
  rowCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface DuplicateFileSummary {
  batchId: string;
  createdAt: string;
  status: string;
}

export interface NewDraftBatch {
  orgId: string;
  integrationId: string;
  createdBy: string;
  fileName: string;
  fileSha256: string;
  fileSize: number;
  fileFormat: 'csv' | 'xlsx';
  encoding: string | null;
  delimiter: string | null;
  sheetName: string | null;
  headers: string[];
  expiresAt: Date;
}

export interface NewImportRow {
  rowNumber: number;
  raw: Record<string, string>;
  issues: { code: string; field?: string }[];
}

export interface CreatedDraft {
  batchId: string;
  shortCode: string;
  createdAt: string;
  duplicateFileOf: DuplicateFileSummary | null;
}

export class OrderImportDraftLimitError extends Error {
  constructor(readonly drafts: OpenDraftSummary[]) {
    super('The organization already holds the maximum number of open drafts');
    this.name = OrderImportDraftLimitError.name;
  }
}

export class OrderImportShortCodeError extends Error {
  constructor() {
    super('Could not allocate a unique batch short code');
    this.name = OrderImportShortCodeError.name;
  }
}

export type DiscardDraftResult =
  | { outcome: 'discarded' }
  | { outcome: 'not_found' }
  | { outcome: 'state_conflict'; status: string };

@Injectable()
export class OrderImportsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Unexpired drafts, newest first. Expired ones await the purge job. */
  async listOpenDrafts(
    orgId: string,
    now: Date,
    executor: Database | Transaction = this.db,
  ): Promise<OpenDraftSummary[]> {
    const rows = await executor
      .select({
        batchId: orderImportBatches.id,
        fileName: orderImportBatches.fileName,
        rowCount: orderImportBatches.rowCount,
        createdAt: orderImportBatches.createdAt,
        expiresAt: orderImportBatches.expiresAt,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.status, 'draft'),
          gt(orderImportBatches.expiresAt, now.toISOString()),
        ),
      )
      .orderBy(desc(orderImportBatches.createdAt));
    return rows;
  }

  /** The newest batch of the same file in the window, whatever its status but expired. */
  async findRecentDuplicate(
    orgId: string,
    fileSha256: string,
    since: Date,
    executor: Database | Transaction = this.db,
  ): Promise<DuplicateFileSummary | null> {
    const [row] = await executor
      .select({
        batchId: orderImportBatches.id,
        createdAt: orderImportBatches.createdAt,
        status: orderImportBatches.status,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.fileSha256, fileSha256),
          gte(orderImportBatches.createdAt, since.toISOString()),
          ne(orderImportBatches.status, 'expired'),
        ),
      )
      .orderBy(desc(orderImportBatches.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Creates the draft and all its rows in one transaction, so an upload is
   * either fully stored or not at all.
   *
   * A per-organization advisory lock serializes concurrent uploads, so the
   * open-draft cap cannot be overshot by two requests that both counted two
   * drafts. The duplicate-file lookup runs under the same lock, before the
   * insert, so a batch never reports itself as its own duplicate.
   */
  async createDraftWithRows(
    batch: NewDraftBatch,
    rows: readonly NewImportRow[],
    options: {
      maxOpenDrafts: number;
      duplicateSince: Date;
      now: Date;
      generateShortCode: () => string;
    },
  ): Promise<CreatedDraft> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`order-import-drafts:${batch.orgId}`}, 0))`,
      );
      const drafts = await this.listOpenDrafts(batch.orgId, options.now, tx);
      if (drafts.length >= options.maxOpenDrafts)
        throw new OrderImportDraftLimitError(drafts);
      const duplicateFileOf = await this.findRecentDuplicate(
        batch.orgId,
        batch.fileSha256,
        options.duplicateSince,
        tx,
      );

      let created:
        | { id: string; shortCode: string; createdAt: string }
        | undefined;
      for (
        let attempt = 0;
        attempt < SHORT_CODE_ATTEMPTS && !created;
        attempt++
      ) {
        [created] = await tx
          .insert(orderImportBatches)
          .values({
            orgId: batch.orgId,
            integrationId: batch.integrationId,
            createdBy: batch.createdBy,
            status: 'draft',
            fileName: batch.fileName,
            fileSha256: batch.fileSha256,
            fileSize: batch.fileSize,
            fileFormat: batch.fileFormat,
            encoding: batch.encoding,
            delimiter: batch.delimiter,
            sheetName: batch.sheetName,
            headers: batch.headers,
            rowCount: rows.length,
            expiresAt: batch.expiresAt.toISOString(),
            shortCode: options.generateShortCode(),
          })
          .onConflictDoNothing({
            target: [orderImportBatches.orgId, orderImportBatches.shortCode],
          })
          .returning({
            id: orderImportBatches.id,
            shortCode: orderImportBatches.shortCode,
            createdAt: orderImportBatches.createdAt,
          });
      }
      if (!created) throw new OrderImportShortCodeError();

      for (
        let start = 0;
        start < rows.length;
        start += ORDER_IMPORT_ROW_CHUNK
      ) {
        await tx.insert(orderImportRows).values(
          rows.slice(start, start + ORDER_IMPORT_ROW_CHUNK).map((row) => ({
            batchId: created.id,
            orgId: batch.orgId,
            rowNumber: row.rowNumber,
            raw: row.raw,
            issues: row.issues,
          })),
        );
      }
      return {
        batchId: created.id,
        shortCode: created.shortCode,
        createdAt: created.createdAt,
        duplicateFileOf,
      };
    });
  }

  /**
   * Deletes a draft and, by cascade, its rows. Any other status is left as it
   * is; another organization's batch reads as not found.
   */
  async discardDraft(
    orgId: string,
    batchId: string,
  ): Promise<DiscardDraftResult> {
    return this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(orderImportBatches)
        .where(
          and(
            eq(orderImportBatches.id, batchId),
            eq(orderImportBatches.orgId, orgId),
            eq(orderImportBatches.status, 'draft'),
          ),
        )
        .returning({ id: orderImportBatches.id });
      if (deleted) return { outcome: 'discarded' };
      const [existing] = await tx
        .select({ status: orderImportBatches.status })
        .from(orderImportBatches)
        .where(
          and(
            eq(orderImportBatches.id, batchId),
            eq(orderImportBatches.orgId, orgId),
          ),
        );
      return existing
        ? { outcome: 'state_conflict', status: existing.status }
        : { outcome: 'not_found' };
    });
  }
}
