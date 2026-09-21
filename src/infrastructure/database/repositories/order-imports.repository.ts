import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  integrations,
  orderImportBatches,
  orderImportMappingProfiles,
  orderImportRows,
  orders,
} from '../schema';

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
  /** The suggested (unconfirmed) mapping and options, and the profile used. */
  mapping: unknown;
  options: unknown;
  mappingProfileId: string | null;
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

export interface MappingProfileRecord {
  id: string;
  mapping: unknown;
  options: unknown;
}

export interface BatchForMapping {
  status: string;
  expiresAt: string;
  headers: unknown;
  mapping: unknown;
}

export interface BatchDetailRecord {
  batchId: string;
  shortCode: string;
  status: string;
  fileName: string;
  fileFormat: string;
  fileSha256: string;
  rowCount: number;
  headers: unknown;
  mapping: unknown;
  options: unknown;
  counts: unknown;
  orderDateMin: string | null;
  orderDateMax: string | null;
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
  startDeadlineAt: string | null;
  startedAt: string | null;
  pausedReason: string | null;
  quietHoursUntil: string | null;
  stoppedAt: string | null;
  completedAt: string | null;
  /** The source store's timezone, for release times and quiet hours. */
  storeTimezone: string | null;
}

export interface StoredSampleRow {
  rowNumber: number;
  raw: unknown;
  issues: unknown;
}

export interface ColumnValueCount {
  value: string;
  count: number;
}

export interface SaveMappingInput {
  orgId: string;
  batchId: string;
  userId: string;
  headerSignature: string;
  mapping: unknown;
  options: unknown;
  profile: { mapping: unknown; options: unknown };
  now: Date;
}

export type SaveMappingResult =
  | { outcome: 'saved'; mappingProfileId: string }
  | { outcome: 'not_draft' };

export interface BatchForValidation {
  status: string;
  expiresAt: string;
  integrationId: string;
  mapping: unknown;
  options: unknown;
}

export interface StoredImportRow {
  rowNumber: number;
  raw: Record<string, string>;
  issues: unknown;
  includeOverride: boolean;
}

export interface ValidatedRowWrite {
  rowNumber: number;
  normalized: unknown;
  /** The outcome without the merchant's include override. */
  outcome: string;
  issues: unknown;
  dedupeKey: string | null;
  collapsedInto: number | null;
  /** A stored include override turns this row ready. */
  includable: boolean;
}

export interface ValidationWrite {
  orgId: string;
  batchId: string;
  rows: readonly ValidatedRowWrite[];
  validationVersion: number;
  now: Date;
}

export type WriteValidationResult = 'saved' | 'not_draft';

export type SetIncludeOverrideResult = {
  outcome: 'saved' | 'not_draft' | 'row_not_found' | 'not_includable';
};

export interface ImportRowPageEntry {
  rowNumber: number;
  raw: unknown;
  normalized: unknown;
  outcome: string | null;
  issues: unknown;
  includeOverride: boolean;
  collapsedInto: number | null;
}

/** The organization and source whose orders an import is checked against. */
export interface OrderSourceScope {
  orgId: string;
  integrationId: string;
}

export interface ExistingOrderRecord {
  id: string;
  externalOrderId: string;
  orderNumber: string | null;
  customerPhone: string;
  totalPrice: string | null;
  createdAt: string | null;
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

  /**
   * The newest batch of the same file in the window, whatever its status but
   * expired. `before` looks back from an existing batch: another batch
   * created earlier than it.
   */
  async findRecentDuplicate(
    orgId: string,
    fileSha256: string,
    since: Date,
    executor: Database | Transaction = this.db,
    before?: { batchId: string; createdAt: string },
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
          before ? ne(orderImportBatches.id, before.batchId) : undefined,
          before
            ? lt(orderImportBatches.createdAt, before.createdAt)
            : undefined,
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
            mapping: batch.mapping,
            options: batch.options,
            mappingProfileId: batch.mappingProfileId,
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

  /** The organization's remembered mapping for a header set (US-04.6-03). */
  async findMappingProfile(
    orgId: string,
    headerSignature: string,
  ): Promise<MappingProfileRecord | null> {
    const [row] = await this.db
      .select({
        id: orderImportMappingProfiles.id,
        mapping: orderImportMappingProfiles.mapping,
        options: orderImportMappingProfiles.options,
      })
      .from(orderImportMappingProfiles)
      .where(
        and(
          eq(orderImportMappingProfiles.orgId, orgId),
          eq(orderImportMappingProfiles.headerSignature, headerSignature),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Everything the batch page shows; another organization's batch is null. */
  async findBatchDetail(
    orgId: string,
    batchId: string,
  ): Promise<BatchDetailRecord | null> {
    const [row] = await this.db
      .select({
        batchId: orderImportBatches.id,
        shortCode: orderImportBatches.shortCode,
        status: orderImportBatches.status,
        fileName: orderImportBatches.fileName,
        fileFormat: orderImportBatches.fileFormat,
        fileSha256: orderImportBatches.fileSha256,
        rowCount: orderImportBatches.rowCount,
        headers: orderImportBatches.headers,
        mapping: orderImportBatches.mapping,
        options: orderImportBatches.options,
        counts: orderImportBatches.counts,
        orderDateMin: orderImportBatches.orderDateMin,
        orderDateMax: orderImportBatches.orderDateMax,
        createdAt: orderImportBatches.createdAt,
        expiresAt: orderImportBatches.expiresAt,
        committedAt: orderImportBatches.committedAt,
        startDeadlineAt: orderImportBatches.startDeadlineAt,
        startedAt: orderImportBatches.startedAt,
        pausedReason: orderImportBatches.pausedReason,
        quietHoursUntil: orderImportBatches.quietHoursUntil,
        stoppedAt: orderImportBatches.stoppedAt,
        completedAt: orderImportBatches.completedAt,
        storeTimezone: integrations.timezone,
      })
      .from(orderImportBatches)
      .leftJoin(
        integrations,
        and(
          eq(integrations.id, orderImportBatches.integrationId),
          eq(integrations.orgId, orderImportBatches.orgId),
        ),
      )
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The first rows of a batch in row order, as stored at upload. */
  async readSampleRows(
    orgId: string,
    batchId: string,
    limit: number,
  ): Promise<StoredSampleRow[]> {
    return this.db
      .select({
        rowNumber: orderImportRows.rowNumber,
        raw: orderImportRows.raw,
        issues: orderImportRows.issues,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, batchId),
          eq(orderImportRows.orgId, orgId),
        ),
      )
      .orderBy(asc(orderImportRows.rowNumber))
      .limit(limit);
  }

  /** How many rows of the batch carry an issue code, whatever their outcome. */
  async countRowsWithIssue(
    orgId: string,
    batchId: string,
    code: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, batchId),
          eq(orderImportRows.orgId, orgId),
          sql`${orderImportRows.issues} @> ${JSON.stringify([{ code }])}::jsonb`,
        ),
      );
    return row?.count ?? 0;
  }

  /** Another organization's batch reads as not found. */
  async findBatchForMapping(
    orgId: string,
    batchId: string,
  ): Promise<BatchForMapping | null> {
    const [row] = await this.db
      .select({
        status: orderImportBatches.status,
        expiresAt: orderImportBatches.expiresAt,
        headers: orderImportBatches.headers,
        mapping: orderImportBatches.mapping,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The distinct values of one column across the batch's rows, with counts.
   * A missing cell counts as blank. The column name is a bound parameter.
   */
  async columnValueCounts(
    orgId: string,
    batchId: string,
    column: string,
  ): Promise<ColumnValueCount[]> {
    const value = sql<string>`coalesce(${orderImportRows.raw} ->> ${column}::text, '')`;
    return (
      this.db
        .select({ value, count: sql<number>`count(*)::int` })
        .from(orderImportRows)
        .where(
          and(
            eq(orderImportRows.batchId, batchId),
            eq(orderImportRows.orgId, orgId),
          ),
        )
        // By position: the select's column name is its own bound parameter, so
        // repeating the expression would not be recognized as the same one.
        .groupBy(sql`1`)
    );
  }

  /**
   * Stores a confirmed mapping on a live draft and remembers it for the header
   * set, in one transaction (AC7, AC8).
   *
   * The batch update is conditional on `draft` and unexpired, so it cannot
   * overwrite a batch a concurrent commit or expiry just moved on; when it
   * matches nothing, nothing is written. The profile is one row per
   * organization and header signature, replaced on every save, so saving the
   * same body twice leaves the same state.
   */
  async saveMapping(input: SaveMappingInput): Promise<SaveMappingResult> {
    const now = input.now.toISOString();
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(orderImportBatches)
        .set({
          mapping: input.mapping,
          options: input.options,
          updatedAt: now,
        })
        .where(
          and(
            eq(orderImportBatches.id, input.batchId),
            eq(orderImportBatches.orgId, input.orgId),
            eq(orderImportBatches.status, 'draft'),
            gt(orderImportBatches.expiresAt, now),
          ),
        )
        .returning({ id: orderImportBatches.id });
      if (!updated) return { outcome: 'not_draft' };

      const [profile] = await tx
        .insert(orderImportMappingProfiles)
        .values({
          orgId: input.orgId,
          headerSignature: input.headerSignature,
          mapping: input.profile.mapping,
          options: input.profile.options,
          updatedBy: input.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            orderImportMappingProfiles.orgId,
            orderImportMappingProfiles.headerSignature,
          ],
          set: {
            mapping: input.profile.mapping,
            options: input.profile.options,
            updatedBy: input.userId,
            updatedAt: now,
          },
        })
        .returning({ id: orderImportMappingProfiles.id });

      await tx
        .update(orderImportBatches)
        .set({ mappingProfileId: profile.id })
        .where(
          and(
            eq(orderImportBatches.id, input.batchId),
            eq(orderImportBatches.orgId, input.orgId),
          ),
        );
      return { outcome: 'saved', mappingProfileId: profile.id };
    });
  }

  /** What row validation needs of a batch; another organization's is null. */
  async findBatchForValidation(
    orgId: string,
    batchId: string,
  ): Promise<BatchForValidation | null> {
    const [row] = await this.db
      .select({
        status: orderImportBatches.status,
        expiresAt: orderImportBatches.expiresAt,
        integrationId: orderImportBatches.integrationId,
        mapping: orderImportBatches.mapping,
        options: orderImportBatches.options,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Every row of a batch in row order; bounded by the upload row cap. */
  async listRowsForValidation(
    orgId: string,
    batchId: string,
  ): Promise<StoredImportRow[]> {
    const rows = await this.db
      .select({
        rowNumber: orderImportRows.rowNumber,
        raw: orderImportRows.raw,
        issues: orderImportRows.issues,
        includeOverride: orderImportRows.includeOverride,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, batchId),
          eq(orderImportRows.orgId, orgId),
        ),
      )
      .orderBy(asc(orderImportRows.rowNumber));
    return rows.map((row) => ({
      ...row,
      raw: (row.raw ?? {}) as Record<string, string>,
    }));
  }

  /**
   * Stores one validation run and the batch summary derived from it (AC13),
   * in one transaction on a batch that is still a live draft.
   *
   * The batch row is locked first, so a concurrent include toggle waits. The
   * stored `include_override` is applied here, in SQL, rather than from what
   * validation read, so a toggle made while rows were being validated is not
   * lost.
   */
  async writeValidation(
    input: ValidationWrite,
  ): Promise<WriteValidationResult> {
    const now = input.now.toISOString();
    return this.db.transaction(async (tx) => {
      if (!(await this.lockLiveDraft(tx, input.orgId, input.batchId, now)))
        return 'not_draft';
      for (
        let start = 0;
        start < input.rows.length;
        start += ORDER_IMPORT_ROW_CHUNK
      ) {
        const values = sql.join(
          input.rows
            .slice(start, start + ORDER_IMPORT_ROW_CHUNK)
            .map(
              (row) =>
                sql`(${row.rowNumber}::int, ${JSON.stringify(row.normalized)}::jsonb, ${row.outcome}::text, ${JSON.stringify(row.issues)}::jsonb, ${row.dedupeKey}::text, ${row.collapsedInto}::int, ${row.includable}::boolean)`,
            ),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE ${orderImportRows} AS r
          SET normalized = v.normalized,
              outcome = CASE WHEN v.includable AND r.include_override
                THEN 'ready' ELSE v.outcome END,
              issues = v.issues,
              dedupe_key = v.dedupe_key,
              collapsed_into = v.collapsed_into
          FROM (VALUES ${values}) AS v(row_number, normalized, outcome, issues, dedupe_key, collapsed_into, includable)
          WHERE r.batch_id = ${input.batchId}
            AND r.org_id = ${input.orgId}
            AND r.row_number = v.row_number`);
      }
      await this.refreshSummary(tx, input.orgId, input.batchId, now, {
        validationVersion: input.validationVersion,
      });
      return 'saved';
    });
  }

  /**
   * Sets the merchant's include choice on one row of a live draft and
   * recomputes the batch summary (AC11). `decide` sees the row as stored,
   * under the batch lock, and returns the outcome to store or null to refuse.
   */
  async setIncludeOverride(input: {
    orgId: string;
    batchId: string;
    rowNumber: number;
    include: boolean;
    now: Date;
    decide: (
      row: StoredImportRow & { outcome: string | null },
    ) => string | null;
  }): Promise<SetIncludeOverrideResult> {
    const now = input.now.toISOString();
    return this.db.transaction(async (tx) => {
      if (!(await this.lockLiveDraft(tx, input.orgId, input.batchId, now)))
        return { outcome: 'not_draft' };
      const [row] = await tx
        .select({
          rowNumber: orderImportRows.rowNumber,
          raw: orderImportRows.raw,
          issues: orderImportRows.issues,
          includeOverride: orderImportRows.includeOverride,
          outcome: orderImportRows.outcome,
        })
        .from(orderImportRows)
        .where(this.rowWhere(input.orgId, input.batchId, input.rowNumber));
      if (!row) return { outcome: 'row_not_found' };
      const outcome = input.decide({
        ...row,
        raw: (row.raw ?? {}) as Record<string, string>,
      });
      if (outcome === null) return { outcome: 'not_includable' };
      await tx
        .update(orderImportRows)
        .set({ includeOverride: input.include, outcome })
        .where(this.rowWhere(input.orgId, input.batchId, input.rowNumber));
      await this.refreshSummary(tx, input.orgId, input.batchId, now);
      return { outcome: 'saved' };
    });
  }

  /** One page of rows in row order after `afterRowNumber` (AC14). */
  async pageRows(input: {
    orgId: string;
    batchId: string;
    outcome: string | null;
    afterRowNumber: number;
    limit: number;
  }): Promise<ImportRowPageEntry[]> {
    return this.db
      .select({
        rowNumber: orderImportRows.rowNumber,
        raw: orderImportRows.raw,
        normalized: orderImportRows.normalized,
        outcome: orderImportRows.outcome,
        issues: orderImportRows.issues,
        includeOverride: orderImportRows.includeOverride,
        collapsedInto: orderImportRows.collapsedInto,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, input.batchId),
          eq(orderImportRows.orgId, input.orgId),
          gt(orderImportRows.rowNumber, input.afterRowNumber),
          input.outcome === null
            ? undefined
            : eq(orderImportRows.outcome, input.outcome),
        ),
      )
      .orderBy(asc(orderImportRows.rowNumber))
      .limit(input.limit);
  }

  /** One row as the rows endpoint shows it. */
  async findRow(
    orgId: string,
    batchId: string,
    rowNumber: number,
  ): Promise<ImportRowPageEntry | null> {
    const [row] = await this.db
      .select({
        rowNumber: orderImportRows.rowNumber,
        raw: orderImportRows.raw,
        normalized: orderImportRows.normalized,
        outcome: orderImportRows.outcome,
        issues: orderImportRows.issues,
        includeOverride: orderImportRows.includeOverride,
        collapsedInto: orderImportRows.collapsedInto,
      })
      .from(orderImportRows)
      .where(this.rowWhere(orgId, batchId, rowNumber))
      .limit(1);
    return row ?? null;
  }

  /** L1: orders of the source already holding these external ids. */
  async findOrdersByExternalIds(
    source: OrderSourceScope,
    externalOrderIds: readonly string[],
  ): Promise<ExistingOrderRecord[]> {
    if (externalOrderIds.length === 0) return [];
    return this.selectSourceOrders(
      source,
      inArray(orders.externalOrderId, [...externalOrderIds]),
    );
  }

  /** L3: recent orders of the source to any of these phones. */
  async findRecentOrdersByPhones(
    source: OrderSourceScope,
    phones: readonly string[],
    since: Date,
  ): Promise<ExistingOrderRecord[]> {
    if (phones.length === 0) return [];
    return this.selectSourceOrders(
      source,
      and(
        inArray(orders.customerPhone, [...phones]),
        gte(orders.createdAt, since.toISOString()),
      ),
    );
  }

  /** L3: recent orders of the source with these order numbers, any case. */
  async findRecentOrdersByOrderNumbers(
    source: OrderSourceScope,
    lowerCaseOrderNumbers: readonly string[],
    since: Date,
  ): Promise<ExistingOrderRecord[]> {
    if (lowerCaseOrderNumbers.length === 0) return [];
    return this.selectSourceOrders(
      source,
      and(
        inArray(sql`lower(${orders.orderNumber})`, [...lowerCaseOrderNumbers]),
        gte(orders.createdAt, since.toISOString()),
      ),
    );
  }

  private selectSourceOrders(
    source: OrderSourceScope,
    condition: SQL | undefined,
  ): Promise<ExistingOrderRecord[]> {
    return this.db
      .select({
        id: orders.id,
        externalOrderId: orders.externalOrderId,
        orderNumber: orders.orderNumber,
        customerPhone: orders.customerPhone,
        totalPrice: orders.totalPrice,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.orgId, source.orgId),
          eq(orders.integrationId, source.integrationId),
          condition,
        ),
      );
  }

  private rowWhere(orgId: string, batchId: string, rowNumber: number) {
    return and(
      eq(orderImportRows.batchId, batchId),
      eq(orderImportRows.orgId, orgId),
      eq(orderImportRows.rowNumber, rowNumber),
    );
  }

  /** Locks the batch when it is an unexpired draft; false otherwise. */
  private async lockLiveDraft(
    tx: Transaction,
    orgId: string,
    batchId: string,
    now: string,
  ): Promise<boolean> {
    const [batch] = await tx
      .select({ id: orderImportBatches.id })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.status, 'draft'),
          gt(orderImportBatches.expiresAt, now),
        ),
      )
      .for('update');
    return Boolean(batch);
  }

  /**
   * Counts and the ready-order date range, always derived from the rows so a
   * rerun can never double-count (epic invariant 5).
   */
  private async refreshSummary(
    tx: Transaction,
    orgId: string,
    batchId: string,
    now: string,
    extra: { validationVersion?: number } = {},
  ): Promise<void> {
    const rows = sql`FROM ${orderImportRows} WHERE ${orderImportRows.batchId} = ${batchId} AND ${orderImportRows.orgId} = ${orgId}`;
    const count = (outcome: string) =>
      sql`count(*) FILTER (WHERE ${orderImportRows.outcome} = ${outcome})::int`;
    const readyDate = sql`(${orderImportRows.normalized} ->> 'orderDate')::date`;
    await tx
      .update(orderImportBatches)
      .set({
        // `readyAtCommit` is a snapshot the commit takes before any row
        // leaves `ready`; it is carried across every later recount so the
        // progress denominator stays the number the merchant was shown.
        counts: sql`(SELECT jsonb_build_object(
          'total', count(*)::int,
          'ready', ${count('ready')},
          'invalid', ${count('invalid')},
          'duplicate', ${count('duplicate')},
          'excluded', ${count('excluded')},
          'imported', ${count('imported')}
        ) ${rows}) || COALESCE(
          jsonb_strip_nulls(jsonb_build_object('readyAtCommit', ${orderImportBatches.counts} -> 'readyAtCommit')),
          '{}'::jsonb
        )`,
        orderDateMin: sql`(SELECT min(${readyDate}) ${rows} AND ${orderImportRows.outcome} = 'ready')`,
        orderDateMax: sql`(SELECT max(${readyDate}) ${rows} AND ${orderImportRows.outcome} = 'ready')`,
        ...extra,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
        ),
      );
  }

  /** The batch counts as row validation last left them. */
  async readCounts(
    orgId: string,
    batchId: string,
  ): Promise<Record<string, number>> {
    const [row] = await this.db
      .select({ counts: orderImportBatches.counts })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
        ),
      )
      .limit(1);
    return (row?.counts as Record<string, number> | undefined) ?? {};
  }

  /** The batch fields the commit endpoint decides on. */
  async findBatchForCommit(
    orgId: string,
    batchId: string,
  ): Promise<BatchForCommit | null> {
    const [row] = await this.db
      .select({
        id: orderImportBatches.id,
        status: orderImportBatches.status,
        expiresAt: orderImportBatches.expiresAt,
        integrationId: orderImportBatches.integrationId,
        shortCode: orderImportBatches.shortCode,
        mapping: orderImportBatches.mapping,
        counts: orderImportBatches.counts,
        commitIdempotencyKey: orderImportBatches.commitIdempotencyKey,
        platformStoreUrl: integrations.platformStoreUrl,
      })
      .from(orderImportBatches)
      .innerJoin(
        integrations,
        eq(integrations.id, orderImportBatches.integrationId),
      )
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The batch, if any, that already owns this commit key in the org. */
  async findBatchByCommitKey(
    orgId: string,
    key: string,
  ): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: orderImportBatches.id })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.commitIdempotencyKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Move a live draft to `committing` and record the key that claimed it.
   *
   * One conditional UPDATE is the whole race guard: two tabs, a double-click
   * and a retry after a timeout all reach this statement, and exactly one sees
   * a row back. `readyAtCommit` is snapshotted here, before any row leaves
   * `ready`, so the progress denominator cannot drift as the job runs.
   */
  async claimForCommit(input: {
    orgId: string;
    batchId: string;
    key: string;
    now: Date;
  }): Promise<'claimed' | 'not_draft' | 'key_taken'> {
    const now = input.now.toISOString();
    try {
      const [row] = await this.db
        .update(orderImportBatches)
        .set({
          status: 'committing',
          commitIdempotencyKey: input.key,
          counts: sql`${orderImportBatches.counts} || jsonb_build_object('readyAtCommit', COALESCE(${orderImportBatches.counts} -> 'ready', '0'::jsonb))`,
          updatedAt: now,
        })
        .where(
          and(
            eq(orderImportBatches.id, input.batchId),
            eq(orderImportBatches.orgId, input.orgId),
            eq(orderImportBatches.status, 'draft'),
            gt(orderImportBatches.expiresAt, now),
          ),
        )
        .returning({ id: orderImportBatches.id });
      return row ? 'claimed' : 'not_draft';
    } catch (error) {
      // The (org_id, commit_idempotency_key) unique index is the authority on
      // cross-batch key reuse; the caller's pre-check only saves a round trip.
      if (isUniqueViolation(error)) return 'key_taken';
      throw error;
    }
  }

  /**
   * The next page of rows this commit still has to create.
   *
   * `order_id IS NULL` is what makes the job resumable: a re-run after a crash
   * simply never sees the rows it already linked.
   */
  async listRowsForCommit(input: {
    orgId: string;
    batchId: string;
    afterRowNumber: number;
    limit: number;
  }): Promise<CommitRowRecord[]> {
    const rows = await this.db
      .select({
        rowNumber: orderImportRows.rowNumber,
        normalized: orderImportRows.normalized,
        dedupeKey: orderImportRows.dedupeKey,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, input.batchId),
          eq(orderImportRows.orgId, input.orgId),
          eq(orderImportRows.outcome, 'ready'),
          sql`${orderImportRows.orderId} IS NULL`,
          gt(orderImportRows.rowNumber, input.afterRowNumber),
        ),
      )
      .orderBy(asc(orderImportRows.rowNumber))
      .limit(input.limit);
    return rows.map((row) => ({
      rowNumber: row.rowNumber,
      normalized: (row.normalized ?? {}) as CommitRowRecord['normalized'],
      dedupeKey: row.dedupeKey,
    }));
  }

  /**
   * Record one chunk's outcomes and recount the batch, in one transaction.
   *
   * Counts are rebuilt from the rows rather than incremented, so re-running a
   * chunk after a crash cannot double-count (epic invariant 5).
   */
  async writeCommitChunk(input: {
    orgId: string;
    batchId: string;
    imported: CommitRowLink[];
    alreadyImported: number[];
    now: Date;
  }): Promise<void> {
    const now = input.now.toISOString();
    await this.db.transaction(async (tx) => {
      for (const link of input.imported) {
        await tx
          .update(orderImportRows)
          .set({
            orderId: link.orderId,
            webhookEventId: link.eventId,
            outcome: 'imported',
          })
          .where(this.rowWhere(input.orgId, input.batchId, link.rowNumber));
      }
      if (input.alreadyImported.length > 0) {
        await tx
          .update(orderImportRows)
          .set({
            outcome: 'duplicate',
            issues: sql`COALESCE(${orderImportRows.issues}, '[]'::jsonb) || ${JSON.stringify(
              [{ code: 'ALREADY_IMPORTED', field: 'orderReference' }],
            )}::jsonb`,
          })
          .where(
            and(
              eq(orderImportRows.batchId, input.batchId),
              eq(orderImportRows.orgId, input.orgId),
              inArray(orderImportRows.rowNumber, input.alreadyImported),
            ),
          );
      }
      await this.refreshSummary(tx, input.orgId, input.batchId, now);
    });
  }

  /** Commit finished: the batch is now waiting for the merchant to start it. */
  async finishCommit(input: {
    orgId: string;
    batchId: string;
    now: Date;
    startWindowHours: number;
  }): Promise<void> {
    const now = input.now.toISOString();
    const deadline = new Date(
      input.now.getTime() + input.startWindowHours * 3_600_000,
    ).toISOString();
    await this.db
      .update(orderImportBatches)
      .set({
        status: 'awaiting_start',
        committedAt: now,
        startDeadlineAt: deadline,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.orgId, input.orgId),
          eq(orderImportBatches.status, 'committing'),
        ),
      );
  }

  /**
   * The commit exhausted its retries.
   *
   * Rows already linked keep `imported` and their held events, so the partial
   * import stays startable and the merchant can re-upload the remainder.
   */
  async failCommit(input: {
    orgId: string;
    batchId: string;
    now: Date;
  }): Promise<void> {
    const now = input.now.toISOString();
    await this.db
      .update(orderImportBatches)
      .set({ status: 'failed', updatedAt: now })
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.orgId, input.orgId),
          eq(orderImportBatches.status, 'committing'),
        ),
      );
  }
}

export interface BatchForCommit {
  id: string;
  status: string;
  expiresAt: string;
  integrationId: string;
  shortCode: string;
  mapping: unknown;
  counts: unknown;
  commitIdempotencyKey: string | null;
  /** The source store domain, so the commit job needs no second lookup. */
  platformStoreUrl: string;
}

export interface CommitRowRecord {
  rowNumber: number;
  normalized: Record<string, string>;
  dedupeKey: string | null;
}

export interface CommitRowLink {
  rowNumber: number;
  orderId: string;
  eventId: string;
}

/**
 * Postgres unique-violation, the only error `claimForCommit` interprets.
 *
 * Drizzle wraps the driver error, so the SQLSTATE is on a `cause` rather
 * than the error it throws; walking the chain is what makes the check work
 * against the real driver and not only against a hand-made error.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (
    let current = error;
    current;
    current = (current as { cause?: unknown }).cause
  ) {
    if (typeof current !== 'object') return false;
    if ((current as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
