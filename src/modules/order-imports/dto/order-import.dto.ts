import type { OrderImportReleaseStateDto } from './order-import-release.dto';
import type { RowIssue } from '../parsers/grid.types';
import type {
  OrderImportMappingStateDto,
  OrderImportMappingSuggestionDto,
} from './order-import-mapping.dto';

export interface OrderImportSampleRowDto {
  rowNumber: number;
  raw: Record<string, string>;
  issues: RowIssue[];
}

export interface OrderImportDuplicateFileDto {
  batchId: string;
  createdAt: string;
  status: string;
}

/**
 * `POST /api/order-imports` (US-04.6-02 AC8), with the detected mapping,
 * options, payment values and date-format check (US-04.6-03).
 */
export interface OrderImportUploadResponseDto extends OrderImportMappingSuggestionDto {
  batchId: string;
  status: 'draft';
  fileName: string;
  format: 'csv' | 'xlsx';
  encoding: string | null;
  delimiter: string | null;
  sheetName: string | null;
  ignoredSheets: string[];
  headers: string[];
  rowCount: number;
  sampleRows: OrderImportSampleRowDto[];
  duplicateFileOf?: OrderImportDuplicateFileDto;
}

/** Listed with `IMPORT_TOO_MANY_DRAFTS` so the merchant can resume or discard. */
export interface OrderImportOpenDraftDto {
  batchId: string;
  fileName: string;
  rowCount: number;
  createdAt: string;
  expiresAt: string;
}

/** What the caller may do; viewers see the batch read-only. */
export interface OrderImportPermissionsDto {
  canEdit: boolean;
}

/** `GET /api/order-imports?status=draft`: the open drafts to resume. */
export interface OrderImportDraftListDto {
  drafts: OrderImportOpenDraftDto[];
  permissions: OrderImportPermissionsDto;
}

/** One started import on `GET /api/order-imports?status=active`. */
export interface OrderImportStartedBatchDto {
  batchId: string;
  fileName: string;
  status: string;
  startedAt: string | null;
}

/**
 * `GET /api/order-imports?status=active`: imports still sending, or that
 * finished handing orders over in the last day, for the top bar's progress.
 * Their live counts come from `GET /:id`.
 */
export interface OrderImportActiveListDto {
  batches: OrderImportStartedBatchDto[];
}

/**
 * `GET /api/order-imports/:id` (US-04.6-05): enough to render the wizard step
 * the batch is in after a refresh. A draft past its expiry reads as
 * `expired`. US-04.6-06..08 extend it with commit and lifecycle progress.
 */
export interface OrderImportBatchDetailDto
  extends OrderImportMappingStateDto, Partial<OrderImportReleaseStateDto> {
  batchId: string;
  shortCode: string;
  status: string;
  fileName: string;
  format: string;
  rowCount: number;
  createdAt: string;
  expiresAt: string;
  headers: string[];
  sampleRows: OrderImportSampleRowDto[];
  counts: Record<string, number>;
  orderDateMin: string | null;
  orderDateMax: string | null;
  /** Rows older than the age window; they are not imported. */
  oldOrderCount: number;
  duplicateFileOf?: OrderImportDuplicateFileDto;
  permissions: OrderImportPermissionsDto;
}

export const ORDER_IMPORT_TEMPLATE_FORMATS = ['csv', 'xlsx'] as const;
export type OrderImportTemplateFormat =
  (typeof ORDER_IMPORT_TEMPLATE_FORMATS)[number];

export const ORDER_IMPORT_TEMPLATE_LOCALES = ['ar', 'en'] as const;
export type OrderImportTemplateLocale =
  (typeof ORDER_IMPORT_TEMPLATE_LOCALES)[number];
