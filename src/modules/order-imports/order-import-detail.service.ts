import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderImportReleaseRepository } from '../../infrastructure/database/repositories/order-import-release.repository';
import {
  OrderImportsRepository,
  type BatchDetailRecord,
} from '../../infrastructure/database/repositories/order-imports.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { readBulkImportConfig } from '../../shared/config/bulk-import.config';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { canWriteOrganization } from '../auth/organization-role';
import type {
  OrderImportActiveListDto,
  OrderImportBatchDetailDto,
  OrderImportDraftListDto,
  OrderImportSampleRowDto,
} from './dto/order-import.dto';
import { OrderImportMappingService } from './order-import-mapping.service';
import { orderImportError } from './order-imports.errors';
import type { RowIssue } from './parsers/grid.types';
import type { OrderImportReleaseStateDto } from './dto/order-import-release.dto';
import { lifecycleBuckets } from './release/lifecycle-buckets';

/** Rows the page shows as samples, and the rows the matcher reads. */
const SAMPLE_ROW_COUNT = 5;
const MATCHER_ROW_COUNT = 20;
/** The duplicate-file window, the same 24 hours as at upload. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How far back a finished import may still be settling its last sends. */
const ACTIVE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_BATCHES = 10;
/** Statuses that own held (or once-held) orders and so have release progress. */
const COMMITTED_STATUSES = new Set([
  'awaiting_start',
  'releasing',
  'paused',
  'completed',
  'stopped',
  'not_started',
  'failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

/**
 * The read side of the import wizard (US-04.6-05): the open drafts to
 * resume and one batch as the page renders it after a refresh. Any member
 * may read; `permissions.canEdit` tells the page whether to offer changes.
 */
@Injectable()
export class OrderImportDetailService {
  constructor(
    private readonly repository: OrderImportsRepository,
    private readonly mapping: OrderImportMappingService,
    private readonly releases: OrderImportReleaseRepository,
    private readonly orders: OrdersRepository,
    private readonly config: ConfigService,
  ) {}

  /** Started imports for the top bar's progress (`?status=active`). */
  async listActive(user: AuthenticatedUser): Promise<OrderImportActiveListDto> {
    const batches = await this.repository.listStartedBatches(
      user.orgId,
      new Date(Date.now() - ACTIVE_LOOKBACK_MS),
      MAX_ACTIVE_BATCHES,
    );
    return { batches: batches.map((batch) => ({ ...batch })) };
  }

  async listDrafts(
    user: AuthenticatedUser,
    status: string | undefined,
  ): Promise<OrderImportDraftListDto> {
    // Open drafts, or (listActive) started imports, until the history list
    // (US-04.6-08) extends this route.
    if (status !== 'draft')
      throw orderImportError('IMPORT_VALIDATION_FAILED', {
        fieldErrors: { status: 'status must be draft or active.' },
      });
    const drafts = await this.repository.listOpenDrafts(user.orgId, new Date());
    return {
      drafts: drafts.map((draft) => ({ ...draft })),
      permissions: { canEdit: canWriteOrganization(user.role) },
    };
  }

  async detail(
    user: AuthenticatedUser,
    batchId: string,
  ): Promise<OrderImportBatchDetailDto> {
    const batch = await this.repository.findBatchDetail(user.orgId, batchId);
    if (!batch) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    const now = Date.now();
    const status =
      batch.status === 'draft' && Date.parse(batch.expiresAt) <= now
        ? 'expired'
        : batch.status;
    const headers = stringArray(batch.headers);

    const [storedRows, oldOrderCount, duplicateFileOf] = await Promise.all([
      this.repository.readSampleRows(user.orgId, batchId, MATCHER_ROW_COUNT),
      this.repository.countRowsWithIssue(user.orgId, batchId, 'ORDER_TOO_OLD'),
      this.repository.findRecentDuplicate(
        user.orgId,
        batch.fileSha256,
        new Date(Date.parse(batch.createdAt) - DUPLICATE_WINDOW_MS),
        undefined,
        { batchId, createdAt: batch.createdAt },
      ),
    ]);
    const rows = storedRows.map(
      (row): OrderImportSampleRowDto => ({
        rowNumber: row.rowNumber,
        raw: stringRecord(row.raw),
        issues: Array.isArray(row.issues) ? (row.issues as RowIssue[]) : [],
      }),
    );
    const mapping = await this.mapping.describe(
      user.orgId,
      {
        batchId,
        headers,
        mapping: batch.mapping,
        options: batch.options,
      },
      rows.map((row) => ({
        cells: headers.map((header) => row.raw[header] ?? ''),
      })),
    );

    return {
      batchId: batch.batchId,
      shortCode: batch.shortCode,
      status,
      fileName: batch.fileName,
      format: batch.fileFormat,
      rowCount: batch.rowCount,
      createdAt: batch.createdAt,
      expiresAt: batch.expiresAt,
      headers,
      sampleRows: rows.slice(0, SAMPLE_ROW_COUNT),
      counts: numberRecord(batch.counts),
      orderDateMin: batch.orderDateMin,
      orderDateMax: batch.orderDateMax,
      oldOrderCount,
      ...mapping,
      ...(duplicateFileOf ? { duplicateFileOf } : {}),
      ...(COMMITTED_STATUSES.has(batch.status)
        ? await this.releaseState(user.orgId, batch)
        : {}),
      permissions: { canEdit: canWriteOrganization(user.role) },
    };
  }

  /**
   * Live progress for the releasing, paused and stopped panels (AC12): hold
   * states from the batch's events and lifecycle counts from the same
   * projection as the verifications table, each in one grouped query.
   */
  private async releaseState(
    orgId: string,
    batch: BatchDetailRecord,
  ): Promise<OrderImportReleaseStateDto> {
    const [hold, lifecycle] = await Promise.all([
      this.releases.holdCounts(orgId, batch.batchId),
      this.orders.countLifecycleByImportBatch(orgId, batch.batchId),
    ]);
    return {
      committedAt: batch.committedAt,
      startDeadlineAt: batch.startDeadlineAt,
      startedAt: batch.startedAt,
      pausedReason: batch.pausedReason,
      quietHoursUntil: batch.quietHoursUntil,
      stoppedAt: batch.stoppedAt,
      completedAt: batch.completedAt,
      ratePerMinute: readBulkImportConfig(this.config).releasePerMinute,
      storeTimezone: batch.storeTimezone,
      release: {
        total: hold.held + hold.released + hold.withdrawn,
        ...hold,
      },
      lifecycle: lifecycleBuckets(lifecycle),
    };
  }
}
