import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
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
        counts: sql`(SELECT jsonb_build_object(
          'total', count(*)::int,
          'ready', ${count('ready')},
          'invalid', ${count('invalid')},
          'duplicate', ${count('duplicate')},
          'excluded', ${count('excluded')}
        ) ${rows})`,
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
}
