/*
 * Arabic characters are written as code points on purpose: escapes typed into
 * source through tooling have landed as invisible raw characters before.
 */

/** Arabic-Indic (U+0660) and Extended Arabic-Indic / Persian (U+06F0) digits. */
const DIGIT_BLOCKS = [0x0660, 0x06f0];
const ARABIC_DECIMAL_SEPARATOR = String.fromCharCode(0x066b);
const ARABIC_THOUSANDS_SEPARATOR = String.fromCharCode(0x066c);

/** Zero-width, bidi and other invisible format controls (category Cf). */
const FORMAT_CONTROLS = /\p{Cf}/gu;
const WHITESPACE_RUN = /\s+/g;

/** The ASCII digit for an Eastern digit, else null. */
export function toAsciiDigit(code: number): string | null {
  for (const block of DIGIT_BLOCKS) {
    if (code >= block && code <= block + 9) return String(code - block);
  }
  return null;
}

function toAsciiDigits(value: string): string {
  let result = '';
  for (const char of value)
    result += toAsciiDigit(char.codePointAt(0) ?? 0) ?? char;
  return result;
}

/**
 * The comparable text of one cell (AC1): NFC, Eastern digits as ASCII, the
 * Arabic decimal separator as `.`, the Arabic thousands separator dropped,
 * invisible controls removed and whitespace collapsed.
 */
export function cleanCell(value: string | undefined): string {
  if (!value) return '';
  return toAsciiDigits(value.normalize('NFC'))
    .replaceAll(ARABIC_DECIMAL_SEPARATOR, '.')
    .replaceAll(ARABIC_THOUSANDS_SEPARATOR, '')
    .replace(FORMAT_CONTROLS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}
