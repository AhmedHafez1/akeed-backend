import {
  CSV_MALFORMED_QUOTE,
  isBlankRow,
  type CsvDelimiter,
  type GridReadLimits,
  type GridRow,
} from './grid.types';
import { ImportFileError } from './import-file.error';

export interface CsvRecord {
  cells: string[];
  /** A quote in this record was unterminated or followed by stray text. */
  malformed: boolean;
}

const DELIMITER_CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t'];
const DELIMITER_SAMPLE_LINES = 50;
const DEADLINE_CHECK_EVERY = 500;

function isLineBreak(char: string | undefined): boolean {
  return char === '\n' || char === '\r';
}

function firstLineBreakAfter(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    if (isLineBreak(text[index])) return index;
  }
  return text.length;
}

/**
 * RFC 4180 records, read the way Excel opens a CSV:
 * - a quote is special only at the start of a field; `""` inside a quoted
 *   field is one quote, and a quoted field may span lines;
 * - `\r\n`, `\n` and `\r` all end a record, and may be mixed;
 * - every line counts as a record, blank lines included, so record N is the
 *   row Excel shows as row N.
 *
 * A malformed quote damages only its own record. An unterminated quote (or a
 * quoted field that spans lines and then closes with stray text) ends at the
 * first line break after it opened; a closing quote followed by stray text on
 * the same line keeps that text. Either way the record is flagged and reading
 * resumes on the next line, instead of swallowing the rest of the file.
 */
export function* readCsvRecords(
  text: string,
  delimiter: CsvDelimiter,
): Generator<CsvRecord> {
  const length = text.length;
  let index = 0;
  while (index < length) {
    const cells: string[] = [];
    let malformed = false;
    for (;;) {
      let value: string;
      if (text[index] === '"') {
        const open = index;
        let buffer = '';
        let segmentStart = ++index;
        let closed = false;
        while (index < length) {
          if (text[index] === '"') {
            buffer += text.slice(segmentStart, index);
            if (text[index + 1] === '"') {
              buffer += '"';
              index += 2;
              segmentStart = index;
              continue;
            }
            index++;
            closed = true;
            break;
          }
          index++;
        }
        const strayText =
          closed &&
          index < length &&
          text[index] !== delimiter &&
          !isLineBreak(text[index]);
        if (!closed || (strayText && /[\r\n]/.test(buffer))) {
          const lineEnd = firstLineBreakAfter(text, open + 1);
          value = text.slice(open + 1, lineEnd);
          index = lineEnd;
          malformed = true;
        } else if (strayText) {
          let end = index;
          while (
            end < length &&
            text[end] !== delimiter &&
            !isLineBreak(text[end])
          )
            end++;
          value = buffer + text.slice(index, end);
          index = end;
          malformed = true;
        } else {
          value = buffer;
        }
      } else {
        let end = index;
        while (
          end < length &&
          text[end] !== delimiter &&
          !isLineBreak(text[end])
        )
          end++;
        value = text.slice(index, end);
        index = end;
      }
      cells.push(value);
      if (index < length && text[index] === delimiter) {
        index++;
        continue;
      }
      break;
    }
    if (text[index] === '\r') index += text[index + 1] === '\n' ? 2 : 1;
    else if (text[index] === '\n') index++;
    yield { cells, malformed };
  }
}

/**
 * Picks the delimiter whose split is most consistent over the first 50
 * non-empty lines: the share of lines with the most common column count
 * decides, then the larger column count, and a full tie keeps the earlier of
 * `,`, `;`, tab. A candidate that never splits a line scores zero, so a
 * one-column file reads as comma-separated.
 */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  let best: { delimiter: CsvDelimiter; share: number; columns: number } = {
    delimiter: ',',
    share: 0,
    columns: 0,
  };
  for (const delimiter of DELIMITER_CANDIDATES) {
    const frequency = new Map<number, number>();
    let lines = 0;
    for (const record of readCsvRecords(text, delimiter)) {
      if (isBlankRow(record.cells)) continue;
      frequency.set(
        record.cells.length,
        (frequency.get(record.cells.length) ?? 0) + 1,
      );
      if (++lines === DELIMITER_SAMPLE_LINES) break;
    }
    let modeColumns = 0;
    let modeCount = 0;
    for (const [columns, count] of frequency) {
      if (count > modeCount || (count === modeCount && columns > modeColumns)) {
        modeColumns = columns;
        modeCount = count;
      }
    }
    const share = modeColumns > 1 && lines > 0 ? modeCount / lines : 0;
    if (
      share > best.share ||
      (share === best.share && share > 0 && modeColumns > best.columns)
    )
      best = { delimiter, share, columns: modeColumns };
  }
  return best.delimiter;
}

/** Reads decoded CSV text into non-blank rows with their real row numbers. */
export function parseCsvGrid(
  text: string,
  limits: GridReadLimits,
): { delimiter: CsvDelimiter; rows: GridRow[] } {
  const delimiter = detectCsvDelimiter(text);
  const rows: GridRow[] = [];
  let rowNumber = 0;
  for (const record of readCsvRecords(text, delimiter)) {
    rowNumber++;
    if (rowNumber % DEADLINE_CHECK_EVERY === 0) limits.checkDeadline();
    if (isBlankRow(record.cells)) continue;
    if (rows.length === limits.maxNonEmptyRows)
      throw new ImportFileError('IMPORT_ROW_LIMIT_EXCEEDED', 'row_limit');
    rows.push({
      rowNumber,
      cells: record.cells,
      issues: record.malformed ? [{ code: CSV_MALFORMED_QUOTE }] : [],
    });
  }
  return { delimiter, rows };
}
