import {
  CANONICAL_ORDER_CURRENCIES,
  isCanonicalCurrency,
  normalizeCanonicalCurrency,
  type CanonicalOrderCurrency,
} from '../../../shared/commerce/canonical-order.rules';
import type { FieldResult } from './phone';

/* Arabic spellings are built from code points; see text.ts. */
const ar = (...codes: number[]) => String.fromCharCode(...codes);

/**
 * Currency words and symbols merchants type next to amounts (AC4, AC5), with
 * the ISO code each one means. Every canonical code is its own alias.
 */
const CURRENCY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  [ar(0x062c, 0x002e, 0x0645), 'EGP'], // ج.م
  [ar(0x062c, 0x0646, 0x064a, 0x0647), 'EGP'], // جنيه
  ['l.e', 'EGP'],
  ['le', 'EGP'],
  [ar(0x0631, 0x002e, 0x0633), 'SAR'], // ر.س
  [ar(0x0631, 0x064a, 0x0627, 0x0644), 'SAR'], // ريال
  [ar(0x062f, 0x002e, 0x0625), 'AED'], // د.إ
  [ar(0x062f, 0x0631, 0x0647, 0x0645), 'AED'], // درهم
  ['$', 'USD'],
  ...CANONICAL_ORDER_CURRENCIES.map(
    (code) => [code.toLowerCase(), code] as const,
  ),
];

/** Longest first, so `l.e` is found before `le`. */
const ALIASES_BY_LENGTH = [...CURRENCY_ALIASES].sort(
  ([a], [b]) => b.length - a.length,
);

const LATIN_LETTER = /[a-z]/;

function aliasAt(text: string, alias: string): number {
  let from = 0;
  for (;;) {
    const index = text.indexOf(alias, from);
    if (index < 0) return -1;
    // A Latin alias must stand alone, so `le` never matches inside a word.
    const before = text[index - 1] ?? ' ';
    const after = text[index + alias.length] ?? ' ';
    if (
      !LATIN_LETTER.test(alias) ||
      (!LATIN_LETTER.test(before) && !LATIN_LETTER.test(after))
    )
      return index;
    from = index + 1;
  }
}

/**
 * Removes every currency word or symbol from an amount cell and reports the
 * first currency found, so `EGP 750` and `750 ج.م` read as 750.
 */
export function stripCurrency(cell: string): {
  text: string;
  currency: string | null;
} {
  let text = cell.toLowerCase();
  let currency: string | null = null;
  for (const [alias, code] of ALIASES_BY_LENGTH) {
    for (let index = aliasAt(text, alias); index >= 0; ) {
      currency ??= code;
      text = `${text.slice(0, index)} ${text.slice(index + alias.length)}`;
      index = aliasAt(text, alias);
    }
  }
  return { text: text.trim(), currency };
}

/** The ISO code a currency cell means, or the cell upper-cased when unknown. */
function currencyCode(cell: string): string {
  const lowered = cell.toLowerCase();
  const alias = CURRENCY_ALIASES.find(([word]) => word === lowered);
  return alias ? alias[1] : String(normalizeCanonicalCurrency(cell));
}

/**
 * The row currency (AC5): the currency cell, else a currency written in the
 * amount cell, else the import's default. Mixed currencies are fine; one
 * outside the canonical list is not.
 */
export function resolveCurrency(
  cell: string,
  fromAmount: string | null,
  defaultCurrency: string,
): FieldResult<CanonicalOrderCurrency> {
  const code = cell ? currencyCode(cell) : (fromAmount ?? defaultCurrency);
  return isCanonicalCurrency(code)
    ? { ok: true, value: code }
    : {
        ok: false,
        issue: { code: 'CURRENCY_UNSUPPORTED', field: 'currency' },
      };
}
