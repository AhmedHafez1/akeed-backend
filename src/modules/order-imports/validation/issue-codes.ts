/**
 * Bumped whenever a row rule changes meaning, so a batch records which rules
 * judged it and its evidence stays reproducible.
 */
export const VALIDATION_VERSION = 1;

export type RowOutcome = 'ready' | 'invalid' | 'duplicate' | 'excluded';

/** What each row issue code does to its row; the epic contract fixes the codes. */
export const ISSUE_OUTCOME = {
  PHONE_MISSING: 'invalid',
  PHONE_INVALID: 'invalid',
  PHONE_NOT_MOBILE: 'invalid',
  PHONE_MULTIPLE: 'invalid',
  PHONE_SCIENTIFIC_NOTATION: 'invalid',
  NAME_MISSING: 'invalid',
  NAME_TOO_LONG: 'invalid',
  NAME_NOT_TEXT: 'invalid',
  AMOUNT_MISSING: 'invalid',
  AMOUNT_INVALID: 'invalid',
  AMOUNT_NOT_POSITIVE: 'invalid',
  AMOUNT_TOO_LARGE: 'invalid',
  AMOUNT_AMBIGUOUS: 'invalid',
  AMOUNT_TOO_PRECISE: 'invalid',
  CURRENCY_UNSUPPORTED: 'invalid',
  PAYMENT_NOT_COD: 'excluded',
  PAYMENT_UNKNOWN_EXCLUDED: 'excluded',
  ORDER_REF_TOO_LONG: 'invalid',
  ORDER_REF_CONFLICT_IN_FILE: 'invalid',
  DUPLICATE_IN_FILE: 'duplicate',
  ALREADY_IMPORTED: 'duplicate',
  POSSIBLE_DUPLICATE: 'excluded',
  ORDER_DATE_INVALID: 'invalid',
  ORDER_DATE_FUTURE: 'invalid',
  ORDER_TOO_OLD: 'excluded',
  FIELD_TOO_LONG: 'invalid',
  CSV_MALFORMED_QUOTE: 'invalid',
} as const satisfies Record<string, Exclude<RowOutcome, 'ready'>>;

export type RowIssueCode = keyof typeof ISSUE_OUTCOME;

export interface RowIssue {
  code: RowIssueCode;
  /** The canonical field, or for parser issues the file column. */
  field?: string;
  params?: Record<string, string | number>;
  /**
   * Shown to the merchant but not judged: a parser issue on a column the
   * mapping does not use (a truncated column that is not imported).
   */
  informational?: true;
}

/** Issues the parser stored at upload; every re-validation carries them over. */
export const PARSE_ISSUE_CODES: readonly RowIssueCode[] = [
  'FIELD_TOO_LONG',
  'CSV_MALFORMED_QUOTE',
];

export function isRowIssueCode(value: unknown): value is RowIssueCode {
  return typeof value === 'string' && Object.hasOwn(ISSUE_OUTCOME, value);
}

const PRECEDENCE: readonly Exclude<RowOutcome, 'ready'>[] = [
  'invalid',
  'duplicate',
  'excluded',
];

/**
 * The row outcome from all its issues (AC13): invalid > duplicate > excluded
 * > ready. A merchant's include override lifts only an exclusion whose sole
 * cause is a possible duplicate (AC11).
 */
export function outcomeOf(
  issues: readonly RowIssue[],
  includeOverride = false,
): RowOutcome {
  const judged = issues.filter((issue) => !issue.informational);
  const outcomes = new Set(judged.map((issue) => ISSUE_OUTCOME[issue.code]));
  const worst = PRECEDENCE.find((outcome) => outcomes.has(outcome)) ?? 'ready';
  if (worst === 'excluded' && includeOverride && isIncludable(issues))
    return 'ready';
  return worst;
}

/**
 * Held back only because it may duplicate an existing order: every issue is a
 * possible-duplicate match (there can be one by phone and one by number).
 */
export function isIncludable(issues: readonly RowIssue[]): boolean {
  const judged = issues.filter((issue) => !issue.informational);
  return (
    judged.length > 0 &&
    judged.every((issue) => issue.code === 'POSSIBLE_DUPLICATE')
  );
}
