import { normalizePaymentSignal } from './payment-signals';

/*
 * The field rules of a canonical Standalone order, defined once.
 *
 * `CreateManualOrderDto` reads these in its decorators and the file import
 * calls the validators below, so a value the manual form accepts is accepted
 * by the import and vice versa. Only cell-text cleanup (digits, separators,
 * currency words) is import-specific.
 */

export const CANONICAL_PHONE_MIN_LENGTH = 7;
export const CANONICAL_PHONE_MAX_LENGTH = 20;
export const CANONICAL_NAME_MAX_LENGTH = 255;
export const CANONICAL_ORDER_NUMBER_MAX_LENGTH = 100;
export const CANONICAL_PAYMENT_METHOD_MAX_LENGTH = 100;

/** Greater than zero, at most 10 integer digits and 2 decimals, no sign. */
export const CANONICAL_TOTAL_PRICE_PATTERN =
  /^(?=.{1,13}$)(?!0+(?:\.0{1,2})?$)(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;

export const CANONICAL_ORDER_CURRENCIES = [
  'USD',
  'EUR',
  'EGP',
  'SAR',
  'AED',
  'QAR',
  'KWD',
  'BHD',
  'OMR',
  'JOD',
  'MAD',
] as const;
export type CanonicalOrderCurrency =
  (typeof CANONICAL_ORDER_CURRENCIES)[number];

/** The local currency of each market Akeed serves, by ISO country code. */
export const COUNTRY_CURRENCIES: Readonly<
  Record<string, CanonicalOrderCurrency>
> = {
  EG: 'EGP',
  SA: 'SAR',
  AE: 'AED',
  QA: 'QAR',
  KW: 'KWD',
  BH: 'BHD',
  OM: 'OMR',
  JO: 'JOD',
  MA: 'MAD',
};

/** The payment method the manual form submits for cash on delivery. */
export const CANONICAL_COD_PAYMENT_METHOD = 'cash_on_delivery';

export function isCanonicalCurrency(
  value: unknown,
): value is CanonicalOrderCurrency {
  return (CANONICAL_ORDER_CURRENCIES as readonly unknown[]).includes(value);
}

export function normalizeCanonicalCurrency(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export function normalizeCanonicalPaymentMethod(value: unknown): unknown {
  return typeof value === 'string' ? normalizePaymentSignal(value) : value;
}

export function fitsCanonicalName(value: string): boolean {
  return value.length <= CANONICAL_NAME_MAX_LENGTH;
}

export function fitsCanonicalOrderNumber(value: string): boolean {
  return value.length <= CANONICAL_ORDER_NUMBER_MAX_LENGTH;
}

export function fitsCanonicalPaymentMethod(value: string): boolean {
  return value.length <= CANONICAL_PAYMENT_METHOD_MAX_LENGTH;
}

export type CanonicalTotalPriceFailure =
  | 'not_positive'
  | 'too_precise'
  | 'too_large'
  | 'malformed';

export type CanonicalTotalPriceResult =
  | { ok: true }
  | { ok: false; reason: CanonicalTotalPriceFailure };

const SIGNED_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * The manual form's `totalPrice` rule. The pattern alone decides acceptance;
 * a rejected value is only classified afterwards so the import can say why.
 */
export function validateCanonicalTotalPrice(
  value: string,
): CanonicalTotalPriceResult {
  if (CANONICAL_TOTAL_PRICE_PATTERN.test(value)) return { ok: true };
  const match = SIGNED_DECIMAL.exec(value);
  if (!match) return { ok: false, reason: 'malformed' };
  const [, sign, integer, fraction = ''] = match;
  if (sign || /^0*$/.test(integer + fraction))
    return { ok: false, reason: 'not_positive' };
  if (fraction.length > 2) return { ok: false, reason: 'too_precise' };
  if (integer.replace(/^0+(?=\d)/, '').length > 10)
    return { ok: false, reason: 'too_large' };
  return { ok: false, reason: 'malformed' };
}
