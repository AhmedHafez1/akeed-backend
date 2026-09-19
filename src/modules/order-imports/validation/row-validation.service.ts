import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderImportsRepository,
  type ExistingOrderRecord,
  type OrderSourceScope,
  type StoredImportRow,
} from '../../../infrastructure/database/repositories/order-imports.repository';
import { readBulkImportConfig } from '../../../shared/config/bulk-import.config';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { PhoneService } from '../../../shared/services/phone.service';
import type { StandaloneSource } from '../../order-ingestion/standalone-source-resolver';
import { OrderEligibilityService } from '../../verification-core/order-eligibility.service';
import { detectDateAmbiguity } from '../mapping/date-ambiguity';
import type {
  ImportOptions,
  StoredImportMapping,
} from '../mapping/mapping-rules';
import { orderImportError } from '../order-imports.errors';
import {
  applyExistingOrderMatches,
  applyInFileDedupe,
  type BatchRow,
  type ExistingOrderMatch,
  type ExistingOrders,
} from './batch-dedupe';
import { dateInTimezone } from './date';
import { isIncludable, outcomeOf, VALIDATION_VERSION } from './issue-codes';
import {
  validateRow,
  type RowValidationContext,
  type RowValidatorDeps,
} from './row-validator';
import { cleanCell } from './text';

/*
 * ASSUMPTION / REQUIRES VALIDATION: pilot defaults for the L3 windows, to be
 * revisited against pilot data (story "Evidence and references").
 */
const L3_PHONE_AMOUNT_WINDOW_DAYS = 7;
const L3_ORDER_NUMBER_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** Who is validating: the session's organization and its Standalone source. */
export interface RowValidationScope {
  orgId: string;
  source: StandaloneSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Re-validates every stored row of a draft against its saved mapping and
 * options, and recomputes the batch counts (US-04.6-04).
 *
 * Every row is judged from its raw cells, so a changed mapping or country
 * re-normalizes from scratch. The pure row rules run first, then in-file
 * dedupe (L2), then one set query per lookup against the source's existing
 * orders (L1, L3). The same rows, mapping, options and database state always
 * give the same result.
 */
@Injectable()
export class RowValidationService {
  private readonly logger = new Logger(RowValidationService.name);

  constructor(
    private readonly repository: OrderImportsRepository,
    private readonly phone: PhoneService,
    private readonly eligibility: OrderEligibilityService,
    private readonly config: ConfigService,
  ) {}

  async validateBatch(
    scope: RowValidationScope,
    batchId: string,
    now = new Date(),
  ): Promise<void> {
    const startedAt = Date.now();
    const { orgId, source } = scope;
    const batch = await this.repository.findBatchForValidation(orgId, batchId);
    if (!batch) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    if (batch.integrationId !== source.id)
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: batch.status,
      });
    const mapping = this.readMapping(batch.mapping);
    const options = batch.options as ImportOptions | null;
    if (!mapping || !options) return; // Nothing confirmed to validate against.

    const stored = await this.repository.listRowsForValidation(orgId, batchId);
    const rows = this.validateRows(stored, {
      orgId,
      integrationId: source.id,
      integration: source,
      mapping: mapping.columns,
      options,
      detectedDateFormat: mapping.columns.orderDate
        ? detectDateAmbiguity(
            stored.map((row) =>
              cleanCell(row.raw[mapping.columns.orderDate ?? '']),
            ),
          ).detectedFormat
        : null,
      timezone: source.timezone,
      now,
      maxOrderAgeDays: readBulkImportConfig(this.config).maxOrderAgeDays,
    });
    applyExistingOrderMatches(
      rows,
      await this.findExistingOrders(
        { orgId, integrationId: source.id },
        rows,
        source.timezone,
        now,
      ),
    );

    const result = await this.repository.writeValidation({
      orgId,
      batchId,
      now,
      validationVersion: VALIDATION_VERSION,
      rows: rows.map((row) => ({
        rowNumber: row.rowNumber,
        normalized: row.normalized,
        outcome: outcomeOf(row.issues),
        issues: row.issues,
        dedupeKey: row.dedupeKey,
        collapsedInto: row.collapsedInto,
        includable: isIncludable(row.issues),
      })),
    });
    if (result === 'not_draft')
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT');

    // Codes and counts only; never a cell value.
    const issueCounts: Record<string, number> = {};
    for (const row of rows)
      for (const issue of row.issues)
        issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    this.logger.log(
      buildBackendLog(RowValidationService.name, {
        action: 'order-import-validate',
        outcome: 'success',
        orgId,
        batchId,
        validationVersion: VALIDATION_VERSION,
        rowCount: rows.length,
        issueCounts,
        durationMs: Date.now() - startedAt,
      }),
    );
  }

  /** The pure part of a run: row rules then in-file dedupe (L2). */
  validateRows(
    stored: readonly StoredImportRow[],
    context: RowValidationContext,
  ): BatchRow[] {
    const deps: RowValidatorDeps = {
      standardizeMobile: (phone, country) =>
        this.phone.standardizeMobile(phone, country),
      evaluateEligibility: (params) =>
        this.eligibility.evaluateOrderForVerification(params),
    };
    const rows = [...stored]
      .sort((a, b) => a.rowNumber - b.rowNumber)
      .map((row): BatchRow => {
        const validated = validateRow(row.raw, row.issues, context, deps);
        return {
          rowNumber: row.rowNumber,
          normalized: validated.normalized,
          issues: validated.issues,
          dedupeKey: validated.dedupeKey,
          collapsedInto: null,
        };
      });
    applyInFileDedupe(rows);
    return rows;
  }

  private async findExistingOrders(
    scope: OrderSourceScope,
    rows: readonly BatchRow[],
    timezone: string,
    now: Date,
  ): Promise<ExistingOrders> {
    const ready = rows.filter((row) => outcomeOf(row.issues) === 'ready');
    const distinct = (values: (string | undefined | null)[]) =>
      [...new Set(values.filter((value): value is string => !!value))].sort();
    const since = (days: number) => new Date(now.getTime() - days * DAY_MS);

    const [byExternalId, recentByPhone, recentByOrderNumber] =
      await Promise.all([
        this.repository.findOrdersByExternalIds(
          scope,
          distinct(ready.map((row) => row.dedupeKey)),
        ),
        this.repository.findRecentOrdersByPhones(
          scope,
          distinct(ready.map((row) => row.normalized.customerPhone)),
          since(L3_PHONE_AMOUNT_WINDOW_DAYS),
        ),
        this.repository.findRecentOrdersByOrderNumbers(
          scope,
          distinct(
            ready.map((row) => row.normalized.orderNumber?.toLowerCase()),
          ),
          since(L3_ORDER_NUMBER_WINDOW_DAYS),
        ),
      ]);
    const toMatch = (order: ExistingOrderRecord): ExistingOrderMatch => {
      const createdAt = order.createdAt ?? now.toISOString();
      return {
        ...order,
        createdAt,
        createdDate: dateInTimezone(new Date(createdAt), timezone),
      };
    };
    return {
      byExternalId: byExternalId.map(toMatch),
      recentByPhone: recentByPhone.map(toMatch),
      recentByOrderNumber: recentByOrderNumber.map(toMatch),
    };
  }

  private readMapping(value: unknown): StoredImportMapping | null {
    if (!isRecord(value) || !isRecord(value.columns)) return null;
    const mapping = value as unknown as StoredImportMapping;
    return mapping.confirmed && Array.isArray(mapping.columns.customerName)
      ? mapping
      : null;
  }
}
