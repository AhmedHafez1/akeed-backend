import { BadRequestException } from '@nestjs/common';

/**
 * The one Idempotency-Key format every Standalone write endpoint accepts.
 *
 * Merchants meet one rule, not one per endpoint, and a key minted for the
 * manual order form is valid on an import commit. Extracted from the private
 * `OrdersService.normalizeIdempotencyKey`; the billing purchase path reads the
 * same pattern through its own error type.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The `code` each rejection answers with. The format and the messages are
 * shared; only the code is per-caller, so the manual endpoint keeps the codes
 * its clients already switch on.
 */
export interface IdempotencyKeyCodes {
  /** No header at all. */
  required: string;
  /** Present but the wrong shape. */
  invalid: string;
}

export function normalizeIdempotencyKey(
  value: string | undefined,
  codes: IdempotencyKeyCodes,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Idempotency-Key header is required.',
      code: codes.required,
      fieldErrors: { idempotencyKey: 'Idempotency-Key header is required.' },
    });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Idempotency-Key header is invalid.',
      code: codes.invalid,
      fieldErrors: {
        idempotencyKey:
          'Use 8-128 letters, numbers, dots, underscores, colons, or hyphens.',
      },
    });
  }
  return normalized;
}
