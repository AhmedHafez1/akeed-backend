import { BadRequestException } from '@nestjs/common';
import {
  IDEMPOTENCY_KEY_PATTERN,
  normalizeIdempotencyKey,
} from './idempotency-key';

const MANUAL = {
  required: 'MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED',
  invalid: 'MANUAL_ORDER_VALIDATION_FAILED',
};
const IMPORT = {
  required: 'IMPORT_IDEMPOTENCY_KEY_REQUIRED',
  invalid: 'IMPORT_VALIDATION_FAILED',
};

function bodyOf(value: string | undefined, codes: typeof MANUAL) {
  try {
    normalizeIdempotencyKey(value, codes);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected a rejection');
}

describe('normalizeIdempotencyKey', () => {
  it('accepts a key in range and trims surrounding whitespace', () => {
    expect(normalizeIdempotencyKey('  abc.def:12-34_  ', MANUAL)).toBe(
      'abc.def:12-34_',
    );
    expect(normalizeIdempotencyKey('a'.repeat(128), MANUAL)).toHaveLength(128);
    expect(normalizeIdempotencyKey('12345678', MANUAL)).toBe('12345678');
  });

  it('rejects a missing key with the caller "required" code', () => {
    for (const value of [undefined, '', '   ']) {
      const body = bodyOf(value, MANUAL);
      expect(body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Idempotency-Key header is required.',
        code: 'MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED',
        fieldErrors: { idempotencyKey: 'Idempotency-Key header is required.' },
      });
    }
  });

  it('rejects a malformed key with the caller "invalid" code', () => {
    // Too short, too long, and every character class outside the pattern.
    for (const value of [
      '1234567',
      'a'.repeat(129),
      'has space',
      'sla/sh',
      'plus+key',
      'أحمد1234',
    ]) {
      const body = bodyOf(value, MANUAL);
      expect(body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Idempotency-Key header is invalid.',
        code: 'MANUAL_ORDER_VALIDATION_FAILED',
        fieldErrors: {
          idempotencyKey:
            'Use 8-128 letters, numbers, dots, underscores, colons, or hyphens.',
        },
      });
    }
  });

  it('varies only the code between callers', () => {
    const manual = bodyOf('bad key', MANUAL);
    const imported = bodyOf('bad key', IMPORT);
    expect(imported).toEqual({ ...manual, code: 'IMPORT_VALIDATION_FAILED' });
    expect(bodyOf(undefined, IMPORT)).toEqual({
      ...bodyOf(undefined, MANUAL),
      code: 'IMPORT_IDEMPOTENCY_KEY_REQUIRED',
    });
  });

  it('accepts the deterministic commit key the import UI sends', () => {
    const batchId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(normalizeIdempotencyKey(`commit-${batchId}`, IMPORT)).toBe(
      `commit-${batchId}`,
    );
    expect(IDEMPOTENCY_KEY_PATTERN.test(`commit-${batchId}`)).toBe(true);
  });
});
