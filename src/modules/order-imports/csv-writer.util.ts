/**
 * The one CSV writer for files Akeed hands to merchants (templates here,
 * results and errors in US-04.6-08). Output opens correctly in Excel,
 * including Arabic, and cannot run as a formula.
 */

export const UTF8_BOM = String.fromCharCode(0xfeff);
const LINE_END = '\r\n';

/**
 * Spreadsheet apps evaluate a cell that starts with `=`, `+`, `-` or `@`, and
 * some strip a leading tab or carriage return first, so a customer name like
 * `=HYPERLINK(...)` would become a live link. A leading `'` makes Excel show
 * the text as typed. This is OWASP's CSV-injection guidance.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One cell: formula-escaped, then quoted when RFC 4180 requires it. */
export function escapeCsvCell(
  value: string | number | null | undefined,
): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsvLine(
  cells: readonly (string | number | null | undefined)[],
): string {
  return cells.map(escapeCsvCell).join(',') + LINE_END;
}

/** A whole file: UTF-8 BOM, then CRLF-terminated lines. */
export function toCsv(
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return UTF8_BOM + rows.map(toCsvLine).join('');
}
