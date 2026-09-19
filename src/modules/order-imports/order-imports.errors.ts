import { HttpException, HttpStatus } from '@nestjs/common';
import type { ImportFileErrorCode } from './parsers/import-file.error';

/**
 * HTTP status for every batch-level code this story answers with. The epic
 * fixes the codes; the statuses follow the manual-order conventions (403 for
 * who you are, 409 for the state you are in, 422 for a file we cannot use).
 */
const STATUS: Record<OrderImportErrorCode, HttpStatus> = {
  IMPORT_DISABLED: HttpStatus.FORBIDDEN,
  IMPORT_FILE_REQUIRED: HttpStatus.BAD_REQUEST,
  IMPORT_FILE_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  IMPORT_FILE_TYPE_UNSUPPORTED: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  IMPORT_FILE_PROTECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  IMPORT_FILE_UNREADABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  IMPORT_FILE_EMPTY: HttpStatus.UNPROCESSABLE_ENTITY,
  IMPORT_ROW_LIMIT_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  IMPORT_COLUMN_LIMIT_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  IMPORT_TOO_MANY_DRAFTS: HttpStatus.CONFLICT,
  IMPORT_RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  IMPORT_BATCH_NOT_FOUND: HttpStatus.NOT_FOUND,
  IMPORT_BATCH_STATE_CONFLICT: HttpStatus.CONFLICT,
  IMPORT_BATCH_EXPIRED: HttpStatus.GONE,
  IMPORT_MAPPING_INCOMPLETE: HttpStatus.UNPROCESSABLE_ENTITY,
  IMPORT_VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
};

export type OrderImportErrorCode =
  | ImportFileErrorCode
  | 'IMPORT_DISABLED'
  | 'IMPORT_FILE_REQUIRED'
  | 'IMPORT_FILE_TOO_LARGE'
  | 'IMPORT_TOO_MANY_DRAFTS'
  | 'IMPORT_RATE_LIMITED'
  | 'IMPORT_BATCH_NOT_FOUND'
  | 'IMPORT_BATCH_STATE_CONFLICT'
  | 'IMPORT_BATCH_EXPIRED'
  | 'IMPORT_MAPPING_INCOMPLETE'
  | 'IMPORT_VALIDATION_FAILED';

/** Merchant-facing English copy; the frontend translates by `code`. */
export const ORDER_IMPORT_MESSAGES: Record<OrderImportErrorCode, string> = {
  IMPORT_DISABLED: 'Importing orders from a file is not available.',
  IMPORT_FILE_REQUIRED: 'Attach one CSV or Excel file in the "file" field.',
  IMPORT_FILE_TOO_LARGE: 'The file is larger than 5 MB.',
  IMPORT_FILE_TYPE_UNSUPPORTED:
    'Only .csv and .xlsx files without macros are supported.',
  IMPORT_FILE_PROTECTED:
    'The workbook is password-protected. Remove the password and upload it again.',
  IMPORT_FILE_UNREADABLE: 'The file could not be read.',
  IMPORT_FILE_EMPTY: 'The file has no order rows under its header row.',
  IMPORT_ROW_LIMIT_EXCEEDED: 'The file has more rows than one import allows.',
  IMPORT_COLUMN_LIMIT_EXCEEDED:
    'The file has more columns than one import allows.',
  IMPORT_TOO_MANY_DRAFTS:
    'Finish or discard an open import before starting another.',
  IMPORT_RATE_LIMITED: 'Too many uploads. Wait a minute and try again.',
  IMPORT_BATCH_NOT_FOUND: 'Import not found.',
  IMPORT_BATCH_STATE_CONFLICT: 'This import can no longer be changed.',
  IMPORT_BATCH_EXPIRED:
    'This import expired after 24 hours. Upload the file again.',
  IMPORT_MAPPING_INCOMPLETE: 'Finish matching the columns before continuing.',
  IMPORT_VALIDATION_FAILED: 'The request is not valid.',
};

/**
 * A draft can still be changed: `expired` (or past its expiry) answers
 * EXPIRED, any other non-draft status a state conflict.
 */
export function assertEditableDraft(
  status: string,
  expiresAt: string,
  now: Date,
): void {
  if (
    status === 'expired' ||
    (status === 'draft' && Date.parse(expiresAt) <= now.getTime())
  )
    throw orderImportError('IMPORT_BATCH_EXPIRED');
  if (status !== 'draft')
    throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', { status });
}

export function orderImportError(
  code: OrderImportErrorCode,
  extra: Record<string, unknown> = {},
): HttpException {
  const status = STATUS[code];
  return new HttpException(
    {
      statusCode: status,
      error: HttpStatus[status]
        .toLowerCase()
        .split('_')
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' '),
      message: ORDER_IMPORT_MESSAGES[code],
      code,
      ...extra,
    },
    status,
  );
}
