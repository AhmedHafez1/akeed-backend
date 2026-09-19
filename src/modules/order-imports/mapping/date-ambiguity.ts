import { foldArabicText } from './header-key';

/** `05/06/2026`, `5-6-26`, `05.06.2026 14:30`: day and month in either order. */
export const DAY_MONTH_YEAR =
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T].*)?$/;

export interface DateAmbiguity {
  /** Every day-month date reads as both DMY and MDY, and none settles it. */
  ambiguous: boolean;
  /** The order the values themselves prove, when one does. */
  detectedFormat: 'DMY' | 'MDY' | null;
}

/**
 * Decides whether a date column needs the merchant's date format (AC5).
 *
 * Only `d/m/y`-shaped values count; ISO dates, Excel serials already turned
 * into ISO by the parser, and text are ignored. A value with a first part
 * over 12 proves DMY, a second part over 12 proves MDY. The column is
 * ambiguous when it has such values, all are valid both ways, and none proves
 * an order. Values proving both orders are left to row validation.
 */
export function detectDateAmbiguity(values: Iterable<string>): DateAmbiguity {
  let dayMonthValues = 0;
  let provesDmy = false;
  let provesMdy = false;
  for (const raw of values) {
    const match = DAY_MONTH_YEAR.exec(foldArabicText(raw).trim());
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    // Not a date either way; row validation reports it.
    if (first < 1 || second < 1 || first > 31 || second > 31) continue;
    if (first > 12 && second > 12) continue;
    dayMonthValues++;
    if (first > 12 && second <= 12) provesDmy = true;
    if (second > 12 && first <= 12) provesMdy = true;
  }
  return {
    ambiguous: dayMonthValues > 0 && !provesDmy && !provesMdy,
    detectedFormat:
      provesDmy && !provesMdy ? 'DMY' : provesMdy && !provesDmy ? 'MDY' : null,
  };
}
