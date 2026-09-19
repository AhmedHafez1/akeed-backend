import type { MobilePhoneResult } from '../../../shared/services/phone.service';
import type { RowIssue } from './issue-codes';

export type StandardizeMobile = (
  phone: string,
  countryCode: string,
) => MobilePhoneResult;

export type FieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: RowIssue };

const ARABIC_SEMICOLON = String.fromCharCode(0x061b);
/** `/`, `,`, the Arabic semicolon or the word "or" between two numbers. */
const CANDIDATE_SEPARATOR = new RegExp(
  `[/,${ARABIC_SEMICOLON}]|\\s+or\\s+`,
  'i',
);
/** Fewer digits than the shortest canonical phone is not a second number. */
const MIN_CANDIDATE_DIGITS = 7;

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/**
 * The customer's phone (AC2). Two or more candidate numbers in one cell are
 * refused rather than guessed between; one number is parsed by the shared
 * `PhoneService.standardizeMobile`.
 */
export function validatePhone(
  cell: string,
  country: string,
  standardizeMobile: StandardizeMobile,
): FieldResult<string> {
  if (!cell)
    return { ok: false, issue: { code: 'PHONE_MISSING', field: 'phone' } };
  const candidates = cell
    .split(CANDIDATE_SEPARATOR)
    .filter((part) => digitCount(part) >= MIN_CANDIDATE_DIGITS);
  if (candidates.length >= 2)
    return { ok: false, issue: { code: 'PHONE_MULTIPLE', field: 'phone' } };

  const result = standardizeMobile(cell, country);
  return result.ok
    ? { ok: true, value: result.e164 }
    : { ok: false, issue: { code: result.code, field: 'phone' } };
}
