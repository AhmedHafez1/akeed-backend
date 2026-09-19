import { createHash } from 'node:crypto';

/*
 * Arabic characters are written as code points on purpose: escapes typed into
 * source through tooling have landed as invisible raw characters before.
 */
const ALEF = String.fromCharCode(0x0627);
const HEH = String.fromCharCode(0x0647);
const YEH = String.fromCharCode(0x064a);

/** Harakat, superscript alef, Quranic marks and tatweel. */
const IGNORED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06ed],
  [0x0640, 0x0640],
];

/** Hamza-carrying and wasla alefs, taa marbuta and alef maksura. */
const FOLDED: ReadonlyMap<number, string> = new Map([
  [0x0622, ALEF],
  [0x0623, ALEF],
  [0x0625, ALEF],
  [0x0671, ALEF],
  [0x0629, HEH],
  [0x0649, YEH],
]);

/** Arabic-Indic and Extended Arabic-Indic (Persian) digit blocks. */
const DIGIT_BLOCKS = [0x0660, 0x06f0];

const PUNCTUATION_AND_SPACE = /[\p{P}\p{S}\p{Z}\p{Cf}\s]+/gu;

function isIgnored(code: number): boolean {
  return IGNORED_RANGES.some(([from, to]) => code >= from && code <= to);
}

function foldCharacter(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (isIgnored(code)) return '';
  const folded = FOLDED.get(code);
  if (folded) return folded;
  for (const block of DIGIT_BLOCKS) {
    if (code >= block && code <= block + 9) return String(code - block);
  }
  return char;
}

/**
 * Lowercases and folds Arabic spelling variants (diacritics, tatweel, alef,
 * taa marbuta, alef maksura, Eastern digits) but keeps words apart, so values
 * such as payment methods can still be read word by word.
 */
export function foldArabicText(value: string): string {
  let result = '';
  for (const char of value.normalize('NFC').toLowerCase())
    result += foldCharacter(char);
  return result;
}

/**
 * The comparable form of a header (US-04.6-03 AC1): folded as above, with all
 * punctuation, symbols and whitespace removed. `Order #`, `ORDER-#` and
 * `order` share one key; a header of only punctuation has an empty key.
 */
export function headerKey(header: string): string {
  return foldArabicText(header).replace(PUNCTUATION_AND_SPACE, '');
}

/**
 * Identifies a header set independent of column order and spelling variants
 * (AC8): the SHA-256 of the sorted header keys.
 */
export function headerSignature(headers: readonly string[]): string {
  const keys = headers.map(headerKey).sort();
  return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}
