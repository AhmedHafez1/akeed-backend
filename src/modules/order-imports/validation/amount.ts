import {
  validateCanonicalTotalPrice,
  type CanonicalTotalPriceFailure,
} from '../../../shared/commerce/canonical-order.rules';
import type { RowIssueCode } from './issue-codes';
import { stripCurrency } from './currency';
import type { FieldResult } from './phone';

const NUMBER_TEXT = /^([+-]?)([\d.,]+)$/;

const FAILURE_CODE: Record<CanonicalTotalPriceFailure, RowIssueCode> = {
  not_positive: 'AMOUNT_NOT_POSITIVE',
  too_precise: 'AMOUNT_TOO_PRECISE',
  too_large: 'AMOUNT_TOO_LARGE',
  malformed: 'AMOUNT_INVALID',
};

type Split = { integer: string; fraction: string } | RowIssueCode;

function groupsOfThree(groups: readonly string[]): boolean {
  return (
    /^\d{1,3}$/.test(groups[0]) &&
    groups.slice(1).every((group) => /^\d{3}$/.test(group))
  );
}

/**
 * The decimal separator rules of AC4:
 * - `,` and `.` both present: the last one is the decimal separator.
 * - only `,`: exactly 3 digits after each is thousands (`1,250`), 1–2 digits
 *   after a single one is a decimal (`750,5`), anything else is ambiguous.
 * - only `.`: one is a decimal; several must all group thousands.
 */
function splitNumber(body: string): Split {
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalAt = Math.max(lastComma, lastDot);
    const thousands = body[decimalAt] === '.' ? ',' : '.';
    const integer = body.slice(0, decimalAt).split(thousands).join('');
    const fraction = body.slice(decimalAt + 1);
    if (!/^\d*$/.test(integer) || !/^\d+$/.test(fraction))
      return 'AMOUNT_INVALID';
    return { integer, fraction };
  }
  if (lastComma >= 0) {
    const groups = body.split(',');
    if (groups.length === 2 && /^\d{1,2}$/.test(groups[1]))
      return { integer: groups[0], fraction: groups[1] };
    if (groupsOfThree(groups))
      return { integer: groups.join(''), fraction: '' };
    return 'AMOUNT_AMBIGUOUS';
  }
  if (lastDot >= 0) {
    const groups = body.split('.');
    if (groups.length === 2) return { integer: groups[0], fraction: groups[1] };
    if (groupsOfThree(groups))
      return { integer: groups.join(''), fraction: '' };
    return 'AMOUNT_INVALID';
  }
  return { integer: body, fraction: '' };
}

export interface ParsedAmount {
  /** Two decimals, e.g. `750.50`. */
  totalPrice: string;
  /** A currency written in the amount cell, for rows without one. */
  currency: string | null;
}

/**
 * The order amount (AC4): currency words stripped, separators resolved, then
 * checked by the manual form's own `totalPrice` rule.
 */
export function validateAmount(cell: string): FieldResult<ParsedAmount> {
  const fail = (code: RowIssueCode): FieldResult<ParsedAmount> => ({
    ok: false,
    issue: { code, field: 'amount' },
  });
  if (!cell) return fail('AMOUNT_MISSING');
  const { text, currency } = stripCurrency(cell);
  const match = NUMBER_TEXT.exec(text.replace(/\s+/g, ''));
  if (!match || !/\d/.test(match[2])) return fail('AMOUNT_INVALID');

  const split = splitNumber(match[2]);
  if (typeof split === 'string') return fail(split);
  const integer = split.integer.replace(/^0+(?=\d)/, '') || '0';
  const decimal = `${match[1] === '-' ? '-' : ''}${integer}${
    split.fraction ? `.${split.fraction}` : ''
  }`;

  const verdict = validateCanonicalTotalPrice(decimal);
  if (!verdict.ok) return fail(FAILURE_CODE[verdict.reason]);
  return {
    ok: true,
    value: {
      totalPrice: `${integer}.${split.fraction.padEnd(2, '0')}`,
      currency,
    },
  };
}
