import { HttpException, HttpStatus } from '@nestjs/common';
import type { CreditDenialCode } from '../../shared/billing/credit-eligibility';
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
  IMPORT_IDEMPOTENCY_KEY_REQUIRED: HttpStatus.BAD_REQUEST,
  IMPORT_IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  IMPORT_NOTHING_TO_IMPORT: HttpStatus.CONFLICT,
  IMPORT_ATTESTATION_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  IMPORT_QUOTE_STALE: HttpStatus.CONFLICT,
  IMPORT_START_WINDOW_EXPIRED: HttpStatus.CONFLICT,
  IMPORT_AUTO_VERIFY_DISABLED: HttpStatus.CONFLICT,
  IMPORT_SETUP_INCOMPLETE: HttpStatus.CONFLICT,
  IMPORT_PLAN_LIMIT_REACHED: HttpStatus.CONFLICT,
  // The shared credit codes, answered as-is so the frontend reuses its
  // existing creditErrors.* copy.
  CREDIT_ACCOUNT_NOT_PROVISIONED: HttpStatus.CONFLICT,
  CREDIT_ACCOUNT_SUSPENDED: HttpStatus.CONFLICT,
  CREDIT_DEBT_OUTSTANDING: HttpStatus.CONFLICT,
  INSUFFICIENT_CREDITS: HttpStatus.CONFLICT,
  PAYMENT_PENDING_RECONCILIATION: HttpStatus.CONFLICT,
};

/** A reason the batch cannot start or resume right now (AC2). */
export type ImportStartBlockerCode =
  | 'IMPORT_AUTO_VERIFY_DISABLED'
  | 'IMPORT_SETUP_INCOMPLETE'
  | 'IMPORT_PLAN_LIMIT_REACHED'
  | 'IMPORT_START_WINDOW_EXPIRED'
  | CreditDenialCode;

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
  | 'IMPORT_VALIDATION_FAILED'
  | 'IMPORT_IDEMPOTENCY_KEY_REQUIRED'
  | 'IMPORT_IDEMPOTENCY_CONFLICT'
  | 'IMPORT_NOTHING_TO_IMPORT'
  | 'IMPORT_ATTESTATION_REQUIRED'
  | 'IMPORT_QUOTE_STALE'
  | ImportStartBlockerCode;

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
  IMPORT_IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required.',
  IMPORT_IDEMPOTENCY_CONFLICT:
    'That Idempotency-Key was already used for a different import.',
  IMPORT_NOTHING_TO_IMPORT: 'There are no ready orders to import.',
  IMPORT_ATTESTATION_REQUIRED:
    'Confirm the current customer-consent statement before starting.',
  IMPORT_QUOTE_STALE:
    'The count or balance changed since you reviewed it. Review the new summary and start again.',
  IMPORT_START_WINDOW_EXPIRED:
    'The time to start this import has passed. Upload the orders again.',
  IMPORT_AUTO_VERIFY_DISABLED:
    'Turn on automatic confirmation in Settings before starting.',
  IMPORT_SETUP_INCOMPLETE: 'Complete Standalone setup before importing orders.',
  IMPORT_PLAN_LIMIT_REACHED:
    'Your plan does not have enough confirmations left for every order.',
  CREDIT_ACCOUNT_NOT_PROVISIONED: 'Credit is not available for this action.',
  CREDIT_ACCOUNT_SUSPENDED: 'Credit is not available for this action.',
  CREDIT_DEBT_OUTSTANDING: 'Credit is not available for this action.',
  INSUFFICIENT_CREDITS: 'Credit is not available for this action.',
  PAYMENT_PENDING_RECONCILIATION: 'Credit is not available for this action.',
};

/** Import keeps its own names for the two shared Idempotency-Key rejections. */
export const IMPORT_IDEMPOTENCY_CODES = {
  required: 'IMPORT_IDEMPOTENCY_KEY_REQUIRED',
  invalid: 'IMPORT_VALIDATION_FAILED',
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
