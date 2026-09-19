import { encode } from 'iconv-lite';
import { strToU8, zipSync } from 'fflate';
import { sanitizeImportFileName } from './file-name';
import { sniffImportFile } from './file-sniffer';
import { createDeadline, ImportFileError } from './import-file.error';
import { decodeImportText } from './text-decoder';
import { inspectZipEntries } from './zip-guard';

const noDeadline = () => undefined;
const CAP = 50 * 1024 * 1024;

function failure(run: () => unknown): { code: string; reason: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof ImportFileError)
      return { code: error.code, reason: error.reason };
    throw error;
  }
  throw new Error('expected an ImportFileError');
}

function zip(files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(files, { level: 9 }));
}

describe('decodeImportText', () => {
  const arabic = 'الاسم,الهاتف';

  it.each([
    [
      'UTF-8 with BOM',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(arabic)]),
      'utf-8',
    ],
    ['UTF-8 without BOM', Buffer.from(arabic), 'utf-8'],
    [
      'UTF-16 LE with BOM',
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(arabic, 'utf16le'),
      ]),
      'utf-16le',
    ],
    [
      'UTF-16 BE with BOM',
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(arabic, 'utf16le').swap16(),
      ]),
      'utf-16be',
    ],
    ['Windows-1256', encode(arabic, 'windows-1256'), 'windows-1256'],
  ])('decodes %s', (_label, bytes, encoding) => {
    expect(decodeImportText(bytes)).toEqual({ text: arabic, encoding });
  });

  it('keeps plain ASCII as UTF-8', () => {
    expect(decodeImportText(Buffer.from('a,b\n1,2'))).toEqual({
      text: 'a,b\n1,2',
      encoding: 'utf-8',
    });
  });
});

describe('inspectZipEntries', () => {
  it('lists entries while counting inflated bytes', () => {
    expect(
      inspectZipEntries(
        zip({ 'a.xml': strToU8('<a/>'), 'b/c.xml': strToU8('<c/>') }),
        CAP,
        noDeadline,
      ),
    ).toEqual(['a.xml', 'b/c.xml']);
  });

  it('stops at the uncompressed cap whatever the headers claim', () => {
    const bomb = zip({ 'x.xml': new Uint8Array(2 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(10_000);
    expect(
      failure(() => inspectZipEntries(bomb, 1024 * 1024, noDeadline)),
    ).toEqual({
      code: 'IMPORT_FILE_UNREADABLE',
      reason: 'uncompressed_limit',
    });
    expect(inspectZipEntries(bomb, 2 * 1024 * 1024, noDeadline)).toEqual([
      'x.xml',
    ]);
  });

  it.each([
    ['inside the first entry header', 20],
    ['inside the compressed data', 40],
  ])('refuses an archive cut off %s', (_label, length) => {
    const archive = zip({ 'x.xml': strToU8('<x>'.repeat(1_000)) });
    expect(
      failure(() =>
        inspectZipEntries(archive.subarray(0, length), CAP, noDeadline),
      ),
    ).toEqual({ code: 'IMPORT_FILE_UNREADABLE', reason: 'zip_corrupt' });
  });
});

describe('sniffImportFile', () => {
  it('reads a ZIP with xl/workbook.xml as XLSX', () => {
    expect(
      sniffImportFile(
        zip({ 'xl/workbook.xml': strToU8('<workbook/>') }),
        CAP,
        noDeadline,
      ),
    ).toEqual({ kind: 'xlsx' });
  });

  it.each([
    [
      'a macro workbook',
      {
        'xl/workbook.xml': strToU8('<w/>'),
        'xl/vbaProject.bin': strToU8('vba'),
      },
      'IMPORT_FILE_TYPE_UNSUPPORTED',
      'macro_workbook',
    ],
    [
      'a binary workbook',
      { 'xl/workbook.bin': strToU8('bin') },
      'IMPORT_FILE_TYPE_UNSUPPORTED',
      'binary_workbook',
    ],
    [
      'a Word document',
      { 'word/document.xml': strToU8('<d/>') },
      'IMPORT_FILE_UNREADABLE',
      'zip_without_workbook',
    ],
  ])('refuses %s', (_label, files, code, reason) => {
    expect(failure(() => sniffImportFile(zip(files), CAP, noDeadline))).toEqual(
      {
        code,
        reason,
      },
    );
  });

  it.each([
    ['a PDF', Buffer.from('%PDF-1.7\nhello'), 'binary_content'],
    [
      'a PNG',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'binary_content',
    ],
    ['NUL bytes', Buffer.from([0x61, 0x00, 0x62]), 'binary_content'],
    [
      'an empty ZIP',
      Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]),
      'zip_without_workbook',
    ],
    [
      'a broken OLE2 header',
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
      'ole2_unknown',
    ],
  ])('refuses %s as unreadable', (_label, bytes, reason) => {
    expect(failure(() => sniffImportFile(bytes, CAP, noDeadline))).toEqual({
      code: 'IMPORT_FILE_UNREADABLE',
      reason,
    });
  });

  it('accepts text, including UTF-16 with its NUL bytes', () => {
    expect(
      sniffImportFile(Buffer.from('a,b\r\n1,2\r\n'), CAP, noDeadline),
    ).toEqual({
      kind: 'text',
    });
    expect(
      sniffImportFile(
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('a\tb', 'utf16le'),
        ]),
        CAP,
        noDeadline,
      ),
    ).toEqual({ kind: 'text' });
  });

  it('refuses an empty upload as empty', () => {
    expect(
      failure(() => sniffImportFile(Buffer.alloc(0), CAP, noDeadline)).code,
    ).toBe('IMPORT_FILE_EMPTY');
  });
});

describe('createDeadline', () => {
  it('throws the parse-timeout refusal once the budget is spent', () => {
    let now = 1_000;
    const check = createDeadline(20_000, () => now);
    now = 21_000;
    expect(() => check()).not.toThrow();
    now = 21_001;
    expect(failure(check)).toEqual({
      code: 'IMPORT_FILE_UNREADABLE',
      reason: 'parse_timeout',
    });
  });
});

describe('sanitizeImportFileName', () => {
  const rtlOverride = String.fromCharCode(0x202e);
  const zeroWidth = String.fromCharCode(0x200b);

  it.each([
    ['C:\\Users\\me\\Desktop\\orders.csv', 'orders.csv'],
    ['../../etc/passwd', 'passwd'],
    [`evil${rtlOverride}vsc.exe`, 'evilvsc.exe'],
    [`ord${zeroWidth}ers\r\n.xlsx`, 'orders.xlsx'],
    ['  طلبات سبتمبر.xlsx  ', 'طلبات سبتمبر.xlsx'],
    ['', 'upload'],
    [undefined, 'upload'],
    ['..', 'upload'],
  ])('stores %j as %j', (input, expected) => {
    expect(sanitizeImportFileName(input)).toBe(expected);
  });

  it('keeps at most 150 characters', () => {
    expect(sanitizeImportFileName(`${'ع'.repeat(200)}.csv`)).toBe(
      'ع'.repeat(150),
    );
  });
});
