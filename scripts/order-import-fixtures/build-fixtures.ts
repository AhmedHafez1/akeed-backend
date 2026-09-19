/**
 * Every order-import file quirk from US-04.6-02 and the E04.6 "File and
 * format" catalogue, built from code so the fixtures are reviewable and can be
 * regenerated. Each fixture carries the result it must parse to, written by
 * hand from the story, never captured from the parser under test.
 */
import { encode } from 'iconv-lite';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { CFB, utils, write, type CellObject, type WorkBook } from 'xlsx';

export interface ExpectedRow {
  rowNumber: number;
  cells: string[];
  issues?: { code: string; field?: string }[];
}

export type FixtureExpectation =
  | { error: string }
  | {
      format: 'csv' | 'xlsx';
      encoding: string | null;
      delimiter: string | null;
      sheetName: string | null;
      ignoredSheets: string[];
      headers: string[];
      rowCount: number;
      /** Every row, unless `rowsAreSample` says these are a subset. */
      rows: ExpectedRow[];
      rowsAreSample?: boolean;
    };

export interface OrderImportFixture {
  file: string;
  description: string;
  build: () => Buffer;
  expected: FixtureExpectation;
}

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const cfb = CFB as {
  utils: {
    cfb_new(): unknown;
    cfb_add(container: unknown, name: string, content: Buffer): void;
  };
  write(container: unknown, options: { type: 'buffer' }): Buffer;
};

function text(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function withBom(value: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text(value)]);
}

type Cell = string | number | CellObject;

function sheet(rows: Cell[][]) {
  return utils.aoa_to_sheet(rows);
}

function workbook(
  sheets: { name: string; rows: Cell[][]; hidden?: 0 | 1 | 2 }[],
  configure?: (book: WorkBook) => void,
): Buffer {
  const book = utils.book_new();
  for (const entry of sheets)
    utils.book_append_sheet(book, sheet(entry.rows), entry.name);
  book.Workbook = {
    ...(book.Workbook ?? {}),
    Sheets: sheets.map((entry) => ({ Hidden: entry.hidden ?? 0 })),
  };
  book.Props = { CreatedDate: FIXED_DATE, ModifiedDate: FIXED_DATE };
  configure?.(book);
  return write(book, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  }) as Buffer;
}

/** Rewrites a package's parts, for quirks SheetJS cannot write directly. */
function repackage(
  source: Buffer,
  change: (files: Record<string, Uint8Array>) => void,
): Buffer {
  const files = unzipSync(new Uint8Array(source));
  change(files);
  const zippable: Zippable = {};
  for (const [name, content] of Object.entries(files)) zippable[name] = content;
  return Buffer.from(zipSync(zippable, { level: 9, mtime: FIXED_DATE }));
}

const ORDER_HEADERS = ['order_id', 'customer_name', 'phone', 'amount'];

function orderRows(count: number): string[][] {
  return Array.from({ length: count }, (_, index) => [
    `ORD-${index + 1}`,
    `Customer ${index + 1}`,
    `010${String(10_000_000 + index).padStart(8, '0')}`,
    `${100 + (index % 50)}.50`,
  ]);
}

function csvOf(rows: string[][]): string {
  return rows.map((row) => row.join(',')).join('\r\n') + '\r\n';
}

const LONG_VALUE = 'ع'.repeat(1_001);

const simpleXlsx = () =>
  workbook([
    {
      name: 'Orders',
      rows: [ORDER_HEADERS, ['A-1', 'Ali', '01001234567', '250']],
    },
  ]);

const simpleXlsxExpected: FixtureExpectation = {
  format: 'xlsx',
  encoding: null,
  delimiter: null,
  sheetName: 'Orders',
  ignoredSheets: [],
  headers: ORDER_HEADERS,
  rowCount: 1,
  rows: [{ rowNumber: 2, cells: ['A-1', 'Ali', '01001234567', '250'] }],
};

export const ORDER_IMPORT_FIXTURES: OrderImportFixture[] = [
  // ---------------------------------------------------------------- text
  {
    file: 'utf8-bom-multiline.csv',
    description:
      'UTF-8 with BOM and CRLF; quoted cells with a line break, a comma and doubled quotes.',
    build: () =>
      withBom(
        'order_id,customer_name,phone,amount,notes\r\n' +
          '1001,أحمد علي,01001234567,250.00,"سطر أول\r\nسطر ثاني"\r\n' +
          '1002,"Sara, Ltd",+201112223334,99.5,"She said ""ok"""\r\n',
      ),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: ['order_id', 'customer_name', 'phone', 'amount', 'notes'],
      rowCount: 2,
      rows: [
        {
          rowNumber: 2,
          cells: [
            '1001',
            'أحمد علي',
            '01001234567',
            '250.00',
            'سطر أول\r\nسطر ثاني',
          ],
        },
        {
          rowNumber: 3,
          cells: [
            '1002',
            'Sara, Ltd',
            '+201112223334',
            '99.5',
            'She said "ok"',
          ],
        },
      ],
    },
  },
  {
    file: 'utf16le-tab.csv',
    description:
      'Arabic Excel "Unicode text": UTF-16 LE with BOM, tab-separated.',
    build: () =>
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          'رقم الطلب\tاسم العميل\tالهاتف\tالمبلغ\r\n' +
            '1\tمحمد\t01001234567\t150\r\n' +
            '2\tفاطمة\t01201234567\t200\r\n',
          'utf16le',
        ),
      ]),
    expected: {
      format: 'csv',
      encoding: 'utf-16le',
      delimiter: '\t',
      sheetName: null,
      ignoredSheets: [],
      headers: ['رقم الطلب', 'اسم العميل', 'الهاتف', 'المبلغ'],
      rowCount: 2,
      rows: [
        { rowNumber: 2, cells: ['1', 'محمد', '01001234567', '150'] },
        { rowNumber: 3, cells: ['2', 'فاطمة', '01201234567', '200'] },
      ],
    },
  },
  {
    file: 'windows-1256.csv',
    description:
      'Arabic CSV saved by older Excel in the Windows-1256 code page.',
    build: () =>
      encode(
        'الاسم,الهاتف,المبلغ,المدينة\r\nخالد,01001234567,300,القاهرة\r\n',
        'windows-1256',
      ),
    expected: {
      format: 'csv',
      encoding: 'windows-1256',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: ['الاسم', 'الهاتف', 'المبلغ', 'المدينة'],
      rowCount: 1,
      rows: [
        { rowNumber: 2, cells: ['خالد', '01001234567', '300', 'القاهرة'] },
      ],
    },
  },
  {
    file: 'semicolon.csv',
    description: 'Semicolon-separated with decimal-comma amounts.',
    build: () => text('order_id;name;amount\n1;Ali;125,50\n2;Mona;1.250,00\n'),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ';',
      sheetName: null,
      ignoredSheets: [],
      headers: ['order_id', 'name', 'amount'],
      rowCount: 2,
      rows: [
        { rowNumber: 2, cells: ['1', 'Ali', '125,50'] },
        { rowNumber: 3, cells: ['2', 'Mona', '1.250,00'] },
      ],
    },
  },
  {
    file: 'malformed-quote.csv',
    description:
      'A closing quote followed by stray text, and a quote never closed; only those rows are flagged.',
    build: () =>
      text(
        'id,name,note\n1,Ali,ok\n2,"Bad"x,fine\n3,"Unclosed,also here\n4,Mona,after\n',
      ),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: ['id', 'name', 'note'],
      rowCount: 4,
      rows: [
        { rowNumber: 2, cells: ['1', 'Ali', 'ok'] },
        {
          rowNumber: 3,
          cells: ['2', 'Badx', 'fine'],
          issues: [{ code: 'CSV_MALFORMED_QUOTE' }],
        },
        {
          rowNumber: 4,
          cells: ['3', 'Unclosed,also here', ''],
          issues: [{ code: 'CSV_MALFORMED_QUOTE' }],
        },
        { rowNumber: 5, cells: ['4', 'Mona', 'after'] },
      ],
    },
  },
  {
    file: 'mixed-shape.csv',
    description:
      'Mixed CRLF/LF/CR, trailing delimiter, blank line, blank and duplicate headers, extra and missing cells, a 1,001-character cell and no final newline.',
    build: () =>
      text(
        'Name , Phone,,Name,\r\n' +
          'Ali,0100,x,Dup,\n' +
          '\r\n' +
          'Mona,0101,,, ,extra\r' +
          `Omar,0102,y,${LONG_VALUE},`,
      ),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: ['Name', 'Phone', 'Column 3', 'Name (2)', 'Column 6'],
      rowCount: 3,
      rows: [
        { rowNumber: 2, cells: ['Ali', '0100', 'x', 'Dup', ''] },
        { rowNumber: 4, cells: ['Mona', '0101', '', '', 'extra'] },
        {
          rowNumber: 5,
          cells: ['Omar', '0102', 'y', 'ع'.repeat(1_000), ''],
          issues: [{ code: 'FIELD_TOO_LONG', field: 'Name (2)' }],
        },
      ],
    },
  },
  {
    file: 'header-only.csv',
    description: 'A header and no data rows.',
    build: () => text('order_id,name,phone\r\n'),
    expected: { error: 'IMPORT_FILE_EMPTY' },
  },
  {
    file: 'blank-only.csv',
    description: 'Only blank and whitespace rows.',
    build: () => text('\r\n,,\r\n  ,  \r\n'),
    expected: { error: 'IMPORT_FILE_EMPTY' },
  },
  {
    file: 'zero-bytes.csv',
    description: 'An empty upload.',
    build: () => Buffer.alloc(0),
    expected: { error: 'IMPORT_FILE_EMPTY' },
  },
  {
    file: 'rows-5000.csv',
    description: 'Exactly the row limit.',
    build: () => text(csvOf([ORDER_HEADERS, ...orderRows(5_000)])),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: ORDER_HEADERS,
      rowCount: 5_000,
      rowsAreSample: true,
      rows: [
        {
          rowNumber: 2,
          cells: ['ORD-1', 'Customer 1', '01010000000', '100.50'],
        },
        {
          rowNumber: 5_001,
          cells: ['ORD-5000', 'Customer 5000', '01010004999', '149.50'],
        },
      ],
    },
  },
  {
    file: 'rows-5001.csv',
    description: 'One row over the limit.',
    build: () => text(csvOf([ORDER_HEADERS, ...orderRows(5_001)])),
    expected: { error: 'IMPORT_ROW_LIMIT_EXCEEDED' },
  },
  {
    file: 'cols-100.csv',
    description: 'Exactly the column limit.',
    build: () =>
      text(
        csvOf([
          Array.from({ length: 100 }, (_, index) => `c${index + 1}`),
          Array.from({ length: 100 }, (_, index) => `v${index + 1}`),
        ]),
      ),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: Array.from({ length: 100 }, (_, index) => `c${index + 1}`),
      rowCount: 1,
      rows: [
        {
          rowNumber: 2,
          cells: Array.from({ length: 100 }, (_, index) => `v${index + 1}`),
        },
      ],
    },
  },
  {
    file: 'cols-101.csv',
    description: 'One column over the limit.',
    build: () =>
      text(
        csvOf([
          Array.from({ length: 101 }, (_, index) => `c${index + 1}`),
          Array.from({ length: 101 }, (_, index) => `v${index + 1}`),
        ]),
      ),
    expected: { error: 'IMPORT_COLUMN_LIMIT_EXCEEDED' },
  },
  {
    file: 'pdf-renamed.csv',
    description: 'A PDF saved with a .csv extension.',
    build: () =>
      text(
        '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
      ),
    expected: { error: 'IMPORT_FILE_UNREADABLE' },
  },
  {
    file: 'xlsx-renamed.csv',
    description: 'A workbook saved with a .csv extension is read as XLSX.',
    build: simpleXlsx,
    expected: simpleXlsxExpected,
  },
  {
    file: 'csv-renamed.xlsx',
    description: 'CSV text saved with a .xlsx extension is read as CSV.',
    build: () => text('order_id,name\r\nA-1,Ali\r\n'),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: ['order_id', 'name'],
      rowCount: 1,
      rows: [{ rowNumber: 2, cells: ['A-1', 'Ali'] }],
    },
  },

  // ---------------------------------------------------------------- xlsx
  {
    file: 'arabic-excel.xlsx',
    description: 'A typical Arabic merchant workbook.',
    build: () =>
      workbook([
        {
          name: 'الطلبات',
          rows: [
            [
              'رقم الطلب',
              'اسم العميل',
              'رقم الموبايل',
              'المبلغ',
              'طريقة الدفع',
              'المدينة',
            ],
            [
              '1001',
              'أحمد علي',
              '01001234567',
              250,
              'الدفع عند الاستلام',
              'القاهرة',
            ],
            ['1002', 'منى حسن', '01112223334', 99.5, 'كاش', 'الجيزة'],
          ],
        },
      ]),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'الطلبات',
      ignoredSheets: [],
      headers: [
        'رقم الطلب',
        'اسم العميل',
        'رقم الموبايل',
        'المبلغ',
        'طريقة الدفع',
        'المدينة',
      ],
      rowCount: 2,
      rows: [
        {
          rowNumber: 2,
          cells: [
            '1001',
            'أحمد علي',
            '01001234567',
            '250',
            'الدفع عند الاستلام',
            'القاهرة',
          ],
        },
        {
          rowNumber: 3,
          cells: ['1002', 'منى حسن', '01112223334', '99.5', 'كاش', 'الجيزة'],
        },
      ],
    },
  },
  {
    file: 'hidden-first-sheet.xlsx',
    description:
      'Hidden and very hidden sheets come first; the first visible sheet is read and the rest are listed.',
    build: () =>
      workbook([
        { name: 'Secret', rows: [['do_not_read'], ['x']], hidden: 1 },
        { name: 'VeryHidden', rows: [['do_not_read'], ['y']], hidden: 2 },
        {
          name: 'Orders',
          rows: [
            ['order_id', 'name'],
            ['A-1', 'Ali'],
          ],
        },
        { name: 'Notes', rows: [['note'], ['z']] },
      ]),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Orders',
      ignoredSheets: ['Secret', 'VeryHidden', 'Notes'],
      headers: ['order_id', 'name'],
      rowCount: 1,
      rows: [{ rowNumber: 2, cells: ['A-1', 'Ali'] }],
    },
  },
  {
    file: 'merged-cells.xlsx',
    description: 'A merged range keeps only its top-left value.',
    build: () =>
      workbook(
        [
          {
            name: 'Orders',
            rows: [
              ['order_id', 'name', 'city'],
              ['1', 'Ali', 'Cairo'],
              ['2', 'NOT_TOP_LEFT', 'Giza'],
            ],
          },
        ],
        (book) => {
          book.Sheets.Orders['!merges'] = [
            { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } },
          ];
        },
      ),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Orders',
      ignoredSheets: [],
      headers: ['order_id', 'name', 'city'],
      rowCount: 2,
      rows: [
        { rowNumber: 2, cells: ['1', 'Ali', 'Cairo'] },
        { rowNumber: 3, cells: ['2', '', 'Giza'] },
      ],
    },
  },
  {
    file: 'formulas.xlsx',
    description:
      'Formulas are read from their cached values and never evaluated (a stale cache stays stale).',
    build: () =>
      workbook([
        {
          name: 'Orders',
          rows: [
            ['qty', 'price', 'total', 'city'],
            [
              2,
              50,
              { t: 'n', v: 100, f: 'A2*B2' },
              { t: 's', v: 'Cairo', f: '"Cai"&"ro"' },
            ],
            [
              3,
              10,
              { t: 'n', v: 999, f: 'A3*B3' },
              { t: 'e', v: 0x2a, f: 'NA()' },
            ],
          ],
        },
      ]),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Orders',
      ignoredSheets: [],
      headers: ['qty', 'price', 'total', 'city'],
      rowCount: 2,
      rows: [
        { rowNumber: 2, cells: ['2', '50', '100', 'Cairo'] },
        { rowNumber: 3, cells: ['3', '10', '999', ''] },
      ],
    },
  },
  {
    file: 'serial-dates.xlsx',
    description:
      "Excel serial dates, including the 1900 leap-year bug's phantom 29 February, times and a time-only cell.",
    build: () =>
      workbook([
        {
          name: 'Dates',
          rows: [
            ['label', 'value'],
            ['serial 59', { t: 'n', v: 59, z: 'yyyy-mm-dd' }],
            ['serial 60', { t: 'n', v: 60, z: 'yyyy-mm-dd' }],
            ['serial 61', { t: 'n', v: 61, z: 'yyyy-mm-dd' }],
            ['day first', { t: 'n', v: 45_000, z: 'dd/mm/yyyy' }],
            ['with time', { t: 'n', v: 45_000.5, z: 'yyyy-mm-dd hh:mm' }],
            ['time only', { t: 'n', v: 0.25, z: 'hh:mm' }],
          ],
        },
      ]),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Dates',
      ignoredSheets: [],
      headers: ['label', 'value'],
      rowCount: 6,
      rows: [
        { rowNumber: 2, cells: ['serial 59', '1900-02-28'] },
        { rowNumber: 3, cells: ['serial 60', '1900-02-29'] },
        { rowNumber: 4, cells: ['serial 61', '1900-03-01'] },
        { rowNumber: 5, cells: ['day first', '2023-03-15'] },
        { rowNumber: 6, cells: ['with time', '2023-03-15T12:00:00'] },
        { rowNumber: 7, cells: ['time only', '06:00:00'] },
      ],
    },
  },
  {
    file: 'dates-1904.xlsx',
    description: 'A workbook using the 1904 date system (older Mac Excel).',
    build: () =>
      workbook(
        [
          {
            name: 'Dates',
            rows: [
              ['label', 'value'],
              ['serial 0', { t: 'n', v: 0, z: 'yyyy-mm-dd' }],
              ['serial 1', { t: 'n', v: 1, z: 'yyyy-mm-dd' }],
            ],
          },
        ],
        (book) => {
          book.Workbook = { ...book.Workbook, WBProps: { date1904: true } };
        },
      ),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Dates',
      ignoredSheets: [],
      headers: ['label', 'value'],
      rowCount: 2,
      rows: [
        { rowNumber: 2, cells: ['serial 0', '1904-01-01'] },
        { rowNumber: 3, cells: ['serial 1', '1904-01-02'] },
      ],
    },
  },
  {
    file: 'number-phones.xlsx',
    description:
      'Phones and amounts stored as numbers under General, text, custom and thousands formats.',
    build: () =>
      workbook([
        {
          name: 'Phones',
          rows: [
            ['case', 'value'],
            ['general number', 1_001_234_567],
            ['text format', { t: 'n', v: 1_001_234_567, z: '@' }],
            [
              'custom zero-padded',
              { t: 'n', v: 1_001_234_567, z: '00000000000' },
            ],
            ['typed as text', '01001234567'],
            ['long general number', 201_001_234_567],
            ['thousands amount', { t: 'n', v: 1_250.5, z: '#,##0.00' }],
          ],
        },
      ]),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Phones',
      ignoredSheets: [],
      headers: ['case', 'value'],
      rowCount: 6,
      rows: [
        { rowNumber: 2, cells: ['general number', '1001234567'] },
        { rowNumber: 3, cells: ['text format', '1001234567'] },
        { rowNumber: 4, cells: ['custom zero-padded', '01001234567'] },
        { rowNumber: 5, cells: ['typed as text', '01001234567'] },
        { rowNumber: 6, cells: ['long general number', '201001234567'] },
        { rowNumber: 7, cells: ['thousands amount', '1,250.50'] },
      ],
    },
  },
  {
    file: 'formatted-empty-rows.xlsx',
    description:
      'Formatting applied down to row 1,048,576 with data in 40 rows counts 40 rows.',
    build: () =>
      repackage(
        workbook([{ name: 'Orders', rows: [ORDER_HEADERS, ...orderRows(40)] }]),
        (files) => {
          const path = 'xl/worksheets/sheet1.xml';
          const xml = new TextDecoder().decode(files[path]);
          const styledRows = [
            ...Array.from({ length: 2_000 }, (_, index) => 42 + index),
            1_048_576,
          ]
            .map(
              (row) =>
                `<row r="${row}" s="0" customFormat="1"><c r="A${row}" s="0"/><c r="D${row}" s="0"/></row>`,
            )
            .join('');
          files[path] = strToU8(
            xml
              .replace(
                /<dimension ref="[^"]*"\/>/,
                '<dimension ref="A1:D1048576"/>',
              )
              .replace('</sheetData>', `${styledRows}</sheetData>`),
          );
        },
      ),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Orders',
      ignoredSheets: [],
      headers: ORDER_HEADERS,
      rowCount: 40,
      rowsAreSample: true,
      rows: [
        {
          rowNumber: 2,
          cells: ['ORD-1', 'Customer 1', '01010000000', '100.50'],
        },
        {
          rowNumber: 41,
          cells: ['ORD-40', 'Customer 40', '01010000039', '139.50'],
        },
      ],
    },
  },
  {
    file: 'protected.xlsx',
    description:
      'A password-protected workbook: an OLE2 container with EncryptionInfo and EncryptedPackage.',
    build: () => {
      const container = cfb.utils.cfb_new();
      cfb.utils.cfb_add(
        container,
        'EncryptionInfo',
        Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]),
      );
      cfb.utils.cfb_add(
        container,
        'EncryptedPackage',
        Buffer.alloc(4_096, 0x5a),
      );
      return cfb.write(container, { type: 'buffer' });
    },
    expected: { error: 'IMPORT_FILE_PROTECTED' },
  },
  {
    file: 'macro.xlsm',
    description: 'A macro-enabled workbook carrying xl/vbaProject.bin.',
    build: () =>
      repackage(simpleXlsx(), (files) => {
        files['xl/vbaProject.bin'] = new Uint8Array(512).fill(0x41);
      }),
    expected: { error: 'IMPORT_FILE_TYPE_UNSUPPORTED' },
  },
  {
    file: 'legacy.xls',
    description: 'A legacy Excel 97-2003 (BIFF8) workbook.',
    build: () => {
      const book = utils.book_new();
      utils.book_append_sheet(book, sheet([['order_id'], ['A-1']]), 'Orders');
      return write(book, { type: 'buffer', bookType: 'biff8' }) as Buffer;
    },
    expected: { error: 'IMPORT_FILE_TYPE_UNSUPPORTED' },
  },
  {
    file: 'zip-bomb.xlsx',
    description:
      'A valid workbook whose shared-strings part inflates past the 50 MB cap.',
    build: () =>
      repackage(simpleXlsx(), (files) => {
        files['xl/sharedStrings.xml'] = new Uint8Array(60 * 1024 * 1024).fill(
          0x20,
        );
      }),
    expected: { error: 'IMPORT_FILE_UNREADABLE' },
  },
  {
    file: 'truncated.xlsx',
    description: 'A workbook cut off mid-download.',
    build: () => simpleXlsx().subarray(0, 1_024),
    expected: { error: 'IMPORT_FILE_UNREADABLE' },
  },
];
