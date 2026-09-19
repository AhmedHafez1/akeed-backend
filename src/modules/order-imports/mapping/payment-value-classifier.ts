import {
  isCashOnDeliveryPaymentSignal,
  normalizePaymentSignal,
} from '../../../shared/commerce/payment-signals';
import { foldArabicText } from './header-key';
import type { PaymentClassification } from './mapping-rules';

export type PaymentValueClassification = PaymentClassification | 'unknown';

/** Per-value choices beyond this many distinct values are not offered (AC5). */
export const MAX_LISTED_PAYMENT_VALUES = 50;

/*
 * The import's own dictionaries (AC6), on top of the shared COD signal. Words
 * match whole tokens and phrases whole token runs, so `prepaid` is not `paid`
 * and `vodafone cash` is not `cash`.
 */
const NEGATION_TOKENS = ['not', 'non', 'unpaid', 'غير'];
const NOT_COD_PHRASES = ['vodafone cash'];
const COD_TOKENS = ['cash', 'كاش', 'نقدي', 'collect'];
const COD_PHRASES = ['عند الاستلام'];
const NOT_COD_TOKENS = [
  'paid',
  'مدفوع',
  'visa',
  'card',
  'instapay',
  'wallet',
  'fawry',
  'prepaid',
];

const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u;

/**
 * The key a payment value is classified and stored under in
 * `paymentValueMap`: Arabic spelling folded, then the shared payment-signal
 * normalization. Row validation (US-04.6-04) looks values up with this too.
 */
export function normalizePaymentValue(value: string): string {
  return normalizePaymentSignal(foldArabicText(value));
}

function tokensOf(normalized: string): string[] {
  return normalized.split(TOKEN_SEPARATOR).filter(Boolean);
}

function hasPhrase(tokens: readonly string[], phrase: string): boolean {
  return ` ${tokens.join(' ')} `.includes(` ${tokensOf(phrase).join(' ')} `);
}

const fold = (words: string[]) => words.map(normalizePaymentValue);
const NEGATIONS = fold(NEGATION_TOKENS);
const NOT_COD_PHRASE_KEYS = fold(NOT_COD_PHRASES);
const COD_TOKEN_KEYS = fold(COD_TOKENS);
const COD_PHRASE_KEYS = fold(COD_PHRASES);
const NOT_COD_TOKEN_KEYS = fold(NOT_COD_TOKENS);

/**
 * Auto-classifies one payment value (AC6). A negated value (`غير مدفوع`,
 * `not paid`) is `unknown`: it could mean either, so the merchant decides.
 */
export function classifyPaymentValue(
  value: string,
): PaymentValueClassification {
  const normalized = normalizePaymentValue(value);
  const tokens = tokensOf(normalized);
  if (tokens.length === 0) return 'unknown';
  if (tokens.some((token) => NEGATIONS.includes(token))) return 'unknown';
  if (NOT_COD_PHRASE_KEYS.some((phrase) => hasPhrase(tokens, phrase)))
    return 'not_cod';
  if (
    isCashOnDeliveryPaymentSignal(normalized) ||
    tokens.some((token) => COD_TOKEN_KEYS.includes(token)) ||
    COD_PHRASE_KEYS.some((phrase) => hasPhrase(tokens, phrase))
  )
    return 'cod';
  if (tokens.some((token) => NOT_COD_TOKEN_KEYS.includes(token)))
    return 'not_cod';
  return 'unknown';
}

export interface PaymentValueCount {
  value: string;
  count: number;
}

export interface PaymentValueEntry {
  /** The most common spelling in the file, for display. */
  value: string;
  normalizedValue: string;
  count: number;
  /** The effective classification: the merchant's or saved choice, else auto. */
  classification: PaymentValueClassification;
  autoClassification: PaymentValueClassification;
  source: 'auto' | 'saved' | 'merchant';
}

export interface PaymentValueSummary {
  values: PaymentValueEntry[];
  blankCount: number;
  distinctCount: number;
  /** More distinct values than listed; the rest are auto-classified only. */
  truncated: boolean;
}

export function countValues(values: Iterable<string>): PaymentValueCount[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }));
}

/**
 * The distinct payment values of a column with counts and classifications,
 * most frequent first, at most 50 (AC5, AC6). Spellings that normalize alike
 * are one value. Blank cells are only counted: what a missing payment method
 * means is the store's existing eligibility setting, not a per-file choice.
 */
export function summarizePaymentValues(
  counts: readonly PaymentValueCount[],
  choices: {
    map?: Readonly<Record<string, PaymentClassification>>;
    source?: 'saved' | 'merchant';
  } = {},
): PaymentValueSummary {
  let blankCount = 0;
  const groups = new Map<
    string,
    { count: number; spellings: Map<string, number> }
  >();
  for (const { value, count } of counts) {
    const normalizedValue = normalizePaymentValue(value);
    if (normalizedValue === '') {
      blankCount += count;
      continue;
    }
    const group = groups.get(normalizedValue) ?? {
      count: 0,
      spellings: new Map<string, number>(),
    };
    group.count += count;
    const spelling = value.trim();
    group.spellings.set(spelling, (group.spellings.get(spelling) ?? 0) + count);
    groups.set(normalizedValue, group);
  }

  const ordered = [...groups].sort(
    ([aKey, a], [bKey, b]) =>
      b.count - a.count || (aKey < bKey ? -1 : aKey > bKey ? 1 : 0),
  );
  const values = ordered
    .slice(0, MAX_LISTED_PAYMENT_VALUES)
    .map(([normalizedValue, group]): PaymentValueEntry => {
      const [value] = [...group.spellings].sort(
        ([aText, a], [bText, b]) =>
          b - a || (aText < bText ? -1 : aText > bText ? 1 : 0),
      )[0];
      const autoClassification = classifyPaymentValue(normalizedValue);
      const chosen =
        choices.map && Object.hasOwn(choices.map, normalizedValue)
          ? choices.map[normalizedValue]
          : undefined;
      return {
        value,
        normalizedValue,
        count: group.count,
        classification: chosen ?? autoClassification,
        autoClassification,
        source: chosen ? (choices.source ?? 'merchant') : 'auto',
      };
    });
  return {
    values,
    blankCount,
    distinctCount: groups.size,
    truncated: groups.size > MAX_LISTED_PAYMENT_VALUES,
  };
}
