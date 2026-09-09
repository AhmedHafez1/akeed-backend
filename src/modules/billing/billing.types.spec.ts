import {
  EVENT_ERROR_CODES,
  EVENT_RESULT_CODES,
  PROVIDER_CODE_PATTERN,
  PURCHASE_CURRENCY,
  RECONCILIATION_CODES,
} from './billing.types';

/**
 * `reconciliation_code`, `result_code` and `error_code` are CHECK-constrained
 * by migration 0032. A code that violates the pattern raises 23514 inside the
 * callback transaction, on real money, where the only remaining signal is a
 * provider retry loop. Catch it here instead.
 */
describe('provider code vocabulary', () => {
  it.each([
    ...RECONCILIATION_CODES,
    ...EVENT_RESULT_CODES,
    ...EVENT_ERROR_CODES,
  ])('%s satisfies the database pattern', (code) => {
    expect(code).toMatch(PROVIDER_CODE_PATTERN);
  });

  it.each([
    ['RECONCILIATION_CODES', RECONCILIATION_CODES],
    ['EVENT_RESULT_CODES', EVENT_RESULT_CODES],
    ['EVENT_ERROR_CODES', EVENT_ERROR_CODES],
  ])('%s has no duplicates', (_label, codes) => {
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('prices in the currency the payment_purchases check accepts', () => {
    expect(PURCHASE_CURRENCY).toMatch(/^[A-Z]{3}$/);
  });
});
