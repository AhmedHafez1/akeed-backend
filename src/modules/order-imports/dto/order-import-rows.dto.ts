import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { ImportField } from '../mapping/alias-dictionary';
import type { RowIssue } from '../validation/issue-codes';
import type { NormalizedImportOrder } from '../validation/row-validator';

export const IMPORT_ROW_OUTCOMES = [
  'ready',
  'invalid',
  'duplicate',
  'excluded',
  'imported',
] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];

export const MAX_IMPORT_ROWS_PAGE = 100;
export const DEFAULT_IMPORT_ROWS_PAGE = 50;

/** `GET /api/order-imports/:id/rows` query (AC14). */
export class ListOrderImportRowsQueryDto {
  @IsOptional()
  @IsIn(IMPORT_ROW_OUTCOMES, { message: 'outcome is not supported.' })
  outcome?: ImportRowOutcome;

  @IsOptional()
  @IsString({ message: 'cursor is invalid.' })
  @MaxLength(32, { message: 'cursor is invalid.' })
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor is invalid.' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer.' })
  @Min(1, { message: 'limit must be from 1 to 100.' })
  @Max(MAX_IMPORT_ROWS_PAGE, { message: 'limit must be from 1 to 100.' })
  limit?: number;
}

/** `PATCH /api/order-imports/:id/rows/:rowNumber` body (AC11). */
export class UpdateOrderImportRowDto {
  @IsDefined({ message: 'include is required.' })
  @IsBoolean({ message: 'include must be true or false.' })
  include!: boolean;
}

export interface OrderImportRowDto {
  rowNumber: number;
  /** The file's cells for each mapped field, as uploaded. */
  raw: Partial<Record<ImportField, string>>;
  normalized: NormalizedImportOrder | null;
  outcome: ImportRowOutcome | null;
  /** Codes and params; the client localizes them. */
  issues: RowIssue[];
  includeOverride: boolean;
  collapsedInto: number | null;
}

export interface OrderImportRowsPageDto {
  rows: OrderImportRowDto[];
  nextCursor: string | null;
}

export interface OrderImportRowUpdateResponseDto {
  row: OrderImportRowDto;
  counts: Record<string, number>;
}
