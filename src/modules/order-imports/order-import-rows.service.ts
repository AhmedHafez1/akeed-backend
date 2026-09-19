import { Injectable, Logger } from '@nestjs/common';
import {
  OrderImportsRepository,
  type ImportRowPageEntry,
} from '../../infrastructure/database/repositories/order-imports.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  DEFAULT_IMPORT_ROWS_PAGE,
  type ImportRowOutcome,
  type ListOrderImportRowsQueryDto,
  type OrderImportRowDto,
  type OrderImportRowsPageDto,
  type OrderImportRowUpdateResponseDto,
} from './dto/order-import-rows.dto';
import { IMPORT_FIELDS, type ImportField } from './mapping/alias-dictionary';
import { columnsOf, type ImportColumnMapping } from './mapping/mapping-rules';
import { assertEditableDraft, orderImportError } from './order-imports.errors';
import {
  isIncludable,
  outcomeOf,
  type RowIssue,
} from './validation/issue-codes';
import type { NormalizedImportOrder } from './validation/row-validator';

/** The cursor is the last row number shown, opaque to the client. */
function encodeCursor(rowNumber: number): string {
  return Buffer.from(String(rowNumber), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const rowNumber = Number(decoded);
  if (!/^\d{1,9}$/.test(decoded) || !Number.isSafeInteger(rowNumber))
    throw orderImportError('IMPORT_VALIDATION_FAILED', {
      fieldErrors: { cursor: 'cursor is invalid.' },
    });
  return rowNumber;
}

function issuesOf(value: unknown): RowIssue[] {
  return Array.isArray(value) ? (value as RowIssue[]) : [];
}

function columnMappingOf(mapping: unknown): ImportColumnMapping | null {
  if (typeof mapping !== 'object' || mapping === null) return null;
  const columns = (mapping as { columns?: unknown }).columns;
  if (typeof columns !== 'object' || columns === null) return null;
  const typed = columns as ImportColumnMapping;
  return Array.isArray(typed.customerName) ? typed : null;
}

@Injectable()
export class OrderImportRowsService {
  private readonly logger = new Logger(OrderImportRowsService.name);

  constructor(private readonly repository: OrderImportsRepository) {}

  /** `GET /api/order-imports/:id/rows` (AC14): any member, row order. */
  async list(
    user: AuthenticatedUser,
    batchId: string,
    query: ListOrderImportRowsQueryDto,
  ): Promise<OrderImportRowsPageDto> {
    const batch = await this.repository.findBatchForMapping(
      user.orgId,
      batchId,
    );
    if (!batch) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    const limit = query.limit ?? DEFAULT_IMPORT_ROWS_PAGE;
    const page = await this.repository.pageRows({
      orgId: user.orgId,
      batchId,
      outcome: query.outcome ?? null,
      afterRowNumber: decodeCursor(query.cursor),
      limit: limit + 1,
    });
    const mapping = columnMappingOf(batch.mapping);
    const rows = page.slice(0, limit).map((row) => this.toDto(row, mapping));
    return {
      rows,
      nextCursor:
        page.length > limit
          ? encodeCursor(rows[rows.length - 1].rowNumber)
          : null,
    };
  }

  /**
   * `PATCH /api/order-imports/:id/rows/:rowNumber` (AC11): include or
   * exclude a possible duplicate again. Any other row answers a state
   * conflict; the batch counts are recomputed from the rows.
   */
  async setInclude(
    user: AuthenticatedUser,
    batchId: string,
    rowNumber: number,
    include: boolean,
  ): Promise<OrderImportRowUpdateResponseDto> {
    const now = new Date();
    const batch = await this.repository.findBatchForMapping(
      user.orgId,
      batchId,
    );
    if (!batch) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    assertEditableDraft(batch.status, batch.expiresAt, now);

    const result = await this.repository.setIncludeOverride({
      orgId: user.orgId,
      batchId,
      rowNumber,
      include,
      now,
      decide: (row) => {
        const issues = issuesOf(row.issues);
        return isIncludable(issues) ? outcomeOf(issues, include) : null;
      },
    });
    if (result.outcome === 'row_not_found')
      throw orderImportError('IMPORT_VALIDATION_FAILED', {
        fieldErrors: { rowNumber: 'The import has no row with this number.' },
      });
    if (result.outcome === 'not_includable')
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: batch.status,
        reason: 'row_not_includable',
      });
    if (result.outcome === 'not_draft') {
      const current = await this.repository.findBatchForMapping(
        user.orgId,
        batchId,
      );
      if (!current) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
      assertEditableDraft(current.status, current.expiresAt, new Date());
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: current.status,
      });
    }

    const [row, counts] = await Promise.all([
      this.repository.findRow(user.orgId, batchId, rowNumber),
      this.repository.readCounts(user.orgId, batchId),
    ]);
    if (!row) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    this.logger.log(
      buildBackendLog(OrderImportRowsService.name, {
        action: 'order-import-row-include',
        outcome: 'success',
        orgId: user.orgId,
        batchId,
        rowNumber,
        include,
      }),
    );
    return {
      row: this.toDto(row, columnMappingOf(batch.mapping)),
      counts,
    };
  }

  private toDto(
    row: ImportRowPageEntry,
    mapping: ImportColumnMapping | null,
  ): OrderImportRowDto {
    const cells = (row.raw ?? {}) as Record<string, string>;
    const raw: Partial<Record<ImportField, string>> = {};
    if (mapping)
      for (const field of IMPORT_FIELDS) {
        const columns = columnsOf(mapping, field);
        if (columns.length > 0)
          raw[field] = columns.map((column) => cells[column] ?? '').join(' ');
      }
    return {
      rowNumber: row.rowNumber,
      raw,
      normalized: (row.normalized ?? null) as NormalizedImportOrder | null,
      outcome: row.outcome as ImportRowOutcome | null,
      issues: issuesOf(row.issues),
      includeOverride: row.includeOverride,
      collapsedInto: row.collapsedInto,
    };
  }
}
