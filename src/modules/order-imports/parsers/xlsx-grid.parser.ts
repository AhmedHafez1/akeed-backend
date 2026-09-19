import { read, SSF, type CellObject, type WorkBook } from 'xlsx';
import { isBlankRow, type GridReadLimits, type GridRow } from './grid.types';
import { ImportFileError } from './import-file.error';

interface DateCode {
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
  S: number;
}

/** The two SSF helpers used here; the bundled typings declare SSF as `any`. */
const ssf = SSF as {
  parse_date_code(
    value: number,
    options: { date1904: boolean },
  ): DateCode | null;
  is_date(format: string): boolean;
};

const DEADLINE_CHECK_EVERY = 500;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * An Excel serial as an ISO string, in the workbook's own calendar.
 *
 * SheetJS's date code reproduces Excel's 1900 leap-year bug: serial 60 is the
 * phantom 1900-02-29 and serial 61 is 1900-03-01, so every real date keeps the
 * day Excel shows. Times are local wall-clock; the store's timezone is applied
 * when the row is validated (US-04.6-04).
 */
export function excelSerialToIso(serial: number, date1904: boolean): string {
  const code = ssf.parse_date_code(serial, { date1904 });
  if (!code) return String(serial);
  const date = `${pad(code.y, 4)}-${pad(code.m)}-${pad(code.d)}`;
  const time = `${pad(code.H)}:${pad(code.M)}:${pad(code.S)}`;
  const hasTime = code.H !== 0 || code.M !== 0 || code.S !== 0;
  if (serial >= 0 && serial < 1 && !date1904) return time;
  return hasTime ? `${date}T${time}` : date;
}

/**
 * The cell as text, from its cached value only (formulas are never evaluated).
 *
 * - Date-formatted numbers become ISO dates.
 * - Numbers under a text (`@`) or any explicit format keep the text Excel
 *   displays, so a phone formatted `00000000000` keeps its leading zero.
 * - `General` numbers keep the raw stored number; US-04.6-04 then flags a lost
 *   leading zero or scientific notation instead of this reader guessing.
 */
function cellText(cell: CellObject | undefined, date1904: boolean): string {
  if (!cell) return '';
  switch (cell.t) {
    case 's':
      return typeof cell.v === 'string' ? cell.v : String(cell.v ?? '');
    case 'b':
      return cell.v ? 'TRUE' : 'FALSE';
    case 'n': {
      if (typeof cell.v !== 'number') return '';
      const format = typeof cell.z === 'string' ? cell.z : 'General';
      if (format !== 'General' && ssf.is_date(format))
        return excelSerialToIso(cell.v, date1904);
      if (format === 'General') return String(cell.v);
      return cell.w ?? String(cell.v);
    }
    case 'd':
      return cell.v instanceof Date ? cell.v.toISOString() : '';
    default:
      // 'e' (#N/A, #REF! ...) and 'z' (stub) carry no usable value.
      return '';
  }
}

function readWorkbook(bytes: Buffer): WorkBook {
  try {
    return read(bytes, {
      type: 'buffer',
      dense: true,
      cellNF: true,
      cellText: true,
      cellDates: false,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      sheetStubs: false,
      bookVBA: false,
    });
  } catch {
    throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'workbook_corrupt');
  }
}

type DenseData = (CellObject[] | undefined)[];

/**
 * Clears every merged cell except the top-left one, which is where Excel keeps
 * the merged value. Only rows that exist are visited, so a merge declared over
 * a million empty rows costs nothing.
 */
function clearMergedTails(
  data: DenseData,
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[],
): void {
  for (const merge of merges) {
    const lastRow = Math.min(merge.e.r, data.length - 1);
    for (let r = merge.s.r; r <= lastRow; r++) {
      const row = data[r];
      if (!row) continue;
      const lastColumn = Math.min(merge.e.c, row.length - 1);
      for (let c = merge.s.c; c <= lastColumn; c++) {
        if (r === merge.s.r && c === merge.s.c) continue;
        row[c] = { t: 'z' };
      }
    }
  }
}

/**
 * Reads the first visible worksheet of an XLSX package into non-blank rows
 * numbered as Excel numbers them. Hidden and very hidden sheets, chart sheets
 * and every sheet after the chosen one are reported as ignored.
 *
 * The package must already have passed the uncompressed-size guard.
 */
export function parseXlsxGrid(
  bytes: Buffer,
  limits: GridReadLimits,
): { sheetName: string; ignoredSheets: string[]; rows: GridRow[] } {
  const workbook = readWorkbook(bytes);
  limits.checkDeadline();
  const sheetMeta = workbook.Workbook?.Sheets ?? [];
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const chosen = workbook.SheetNames.findIndex((name, index) => {
    const sheet = workbook.Sheets[name];
    return (
      !sheetMeta[index]?.Hidden &&
      sheet !== undefined &&
      sheet['!type'] !== 'chart' &&
      Array.isArray(sheet['!data'])
    );
  });
  if (chosen === -1)
    throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'no_visible_sheet');
  const sheetName = workbook.SheetNames[chosen];
  const sheet = workbook.Sheets[sheetName];
  const data = sheet['!data'] as DenseData;
  clearMergedTails(data, sheet['!merges'] ?? []);

  const rows: GridRow[] = [];
  for (let r = 0; r < data.length; r++) {
    if (r % DEADLINE_CHECK_EVERY === 0) limits.checkDeadline();
    const row = data[r];
    if (!row) continue;
    const cells: string[] = [];
    for (let c = 0; c < row.length; c++) cells.push(cellText(row[c], date1904));
    if (isBlankRow(cells)) continue;
    if (rows.length === limits.maxNonEmptyRows)
      throw new ImportFileError('IMPORT_ROW_LIMIT_EXCEEDED', 'row_limit');
    rows.push({ rowNumber: r + 1, cells, issues: [] });
  }
  return {
    sheetName,
    ignoredSheets: workbook.SheetNames.filter((_, index) => index !== chosen),
    rows,
  };
}
