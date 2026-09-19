import {
  detectCsvDelimiter,
  parseCsvGrid,
  readCsvRecords,
} from './csv-grid.parser';
import { ImportFileError } from './import-file.error';

function records(text: string, delimiter: ',' | ';' | '\t' = ',') {
  return [...readCsvRecords(text, delimiter)];
}

const noDeadline = { maxNonEmptyRows: 100, checkDeadline: () => undefined };

describe('readCsvRecords', () => {
  it('reads RFC 4180 quoting, escaped quotes and multi-line cells', () => {
    expect(records('a,"b,c","d""e"\r\n"x\ny",z\r\n')).toEqual([
      { cells: ['a', 'b,c', 'd"e'], malformed: false },
      { cells: ['x\ny', 'z'], malformed: false },
    ]);
  });

  it('ends records on CRLF, LF or CR, and keeps a last line without newline', () => {
    expect(records('a\r\nb\nc\rd').map((record) => record.cells)).toEqual([
      ['a'],
      ['b'],
      ['c'],
      ['d'],
    ]);
  });

  it('counts blank lines as records so numbering matches Excel', () => {
    expect(records('a\n\nb\n').map((record) => record.cells)).toEqual([
      ['a'],
      [''],
      ['b'],
    ]);
  });

  it('keeps empty fields around delimiters, including a trailing one', () => {
    expect(records(',a,,\n')[0].cells).toEqual(['', 'a', '', '']);
  });

  it('treats a quote after the start of a field as text, as Excel does', () => {
    expect(records('5" screen,ok\n')).toEqual([
      { cells: ['5" screen', 'ok'], malformed: false },
    ]);
  });

  it('keeps stray text after a closing quote and flags the record', () => {
    expect(records('"ab"cd,e\nnext\n')).toEqual([
      { cells: ['abcd', 'e'], malformed: true },
      { cells: ['next'], malformed: false },
    ]);
  });

  it('ends an unterminated quote at its line and resumes on the next line', () => {
    expect(records('1,"open\n2,two\n3,three\n')).toEqual([
      { cells: ['1', 'open'], malformed: true },
      { cells: ['2', 'two'], malformed: false },
      { cells: ['3', 'three'], malformed: false },
    ]);
  });

  it('does not let a stray quote merge the following rows into one cell', () => {
    // The opening quote on row 1 is closed by row 3's quote; without recovery
    // rows 1-3 would collapse into one record.
    expect(records('1,"open\n2,two\n3,"x"y\n4,four\n')).toEqual([
      { cells: ['1', 'open'], malformed: true },
      { cells: ['2', 'two'], malformed: false },
      { cells: ['3', 'xy'], malformed: true },
      { cells: ['4', 'four'], malformed: false },
    ]);
  });

  it('returns no records for empty text', () => {
    expect(records('')).toEqual([]);
  });
});

describe('detectCsvDelimiter', () => {
  it.each([
    ['comma', 'a,b,c\n1,2,3\n', ','],
    ['semicolon', 'a;b;c\n1;2,5;3\n4;5,5;6\n', ';'],
    ['tab', 'a\tb\tc\n1\t2\t3\n', '\t'],
    ['single column', 'phone\n0100\n0101\n', ','],
    ['a comma inside quoted semicolon data', 'a;b\n"1,2";3\n"4,5";6\n', ';'],
  ])('detects %s', (_label, text, delimiter) => {
    expect(detectCsvDelimiter(text)).toBe(delimiter);
  });

  it('prefers the comma on a full tie', () => {
    expect(detectCsvDelimiter('a,b;c\n1,2;3\n')).toBe(',');
  });

  it('prefers more columns when two delimiters are equally consistent', () => {
    // Every line has one comma (an amount) and three tabs.
    expect(detectCsvDelimiter('a\tb\tc\td,e\n1\t2\t3\t4,5\n')).toBe('\t');
  });

  it('only samples the first 50 non-empty lines', () => {
    const head = Array.from({ length: 50 }, () => 'a;b;c').join('\n');
    const tail = Array.from({ length: 200 }, () => 'a,b,c,d').join('\n');
    expect(detectCsvDelimiter(`${head}\n\n${tail}\n`)).toBe(';');
  });
});

describe('parseCsvGrid', () => {
  it('returns only non-blank rows with their real row numbers', () => {
    expect(parseCsvGrid('h1,h2\n\n,\na,b\n', noDeadline)).toEqual({
      delimiter: ',',
      rows: [
        { rowNumber: 1, cells: ['h1', 'h2'], issues: [] },
        { rowNumber: 4, cells: ['a', 'b'], issues: [] },
      ],
    });
  });

  it('flags a malformed quote on its own row only', () => {
    const { rows } = parseCsvGrid('h1,h2\n1,"x\n2,y\n', noDeadline);
    expect(rows.map((row) => row.issues)).toEqual([
      [],
      [{ code: 'CSV_MALFORMED_QUOTE' }],
      [],
    ]);
  });

  it('stops reading as soon as the non-empty row limit is passed', () => {
    const text = Array.from({ length: 10 }, (_, index) => `r${index}`).join(
      '\n',
    );
    expect(() =>
      parseCsvGrid(text, {
        maxNonEmptyRows: 3,
        checkDeadline: () => undefined,
      }),
    ).toThrow(
      expect.objectContaining({ code: 'IMPORT_ROW_LIMIT_EXCEEDED' }) as Error,
    );
  });

  it('checks the parse deadline while reading', () => {
    const text = Array.from({ length: 1_200 }, () => 'a,b').join('\n');
    const checkDeadline = jest.fn(() => {
      throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'parse_timeout');
    });
    expect(() =>
      parseCsvGrid(text, { maxNonEmptyRows: 5_000, checkDeadline }),
    ).toThrow(ImportFileError);
    expect(checkDeadline).toHaveBeenCalled();
  });
});
