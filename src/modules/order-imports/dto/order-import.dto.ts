import type { RowIssue } from '../parsers/grid.types';
import type { OrderImportMappingSuggestionDto } from './order-import-mapping.dto';

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

export const ORDER_IMPORT_TEMPLATE_FORMATS = ['csv', 'xlsx'] as const;
export type OrderImportTemplateFormat =
  (typeof ORDER_IMPORT_TEMPLATE_FORMATS)[number];

export const ORDER_IMPORT_TEMPLATE_LOCALES = ['ar', 'en'] as const;
export type OrderImportTemplateLocale =
  (typeof ORDER_IMPORT_TEMPLATE_LOCALES)[number];
