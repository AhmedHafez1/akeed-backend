import { read, utils } from 'xlsx';
import { escapeCsvCell, toCsv, toCsvLine, UTF8_BOM } from './csv-writer.util';

describe('csv writer', () => {
  it.each([
    ['plain', 'Ali', 'Ali'],
    ['number', 12.5, '12.5'],
    ['empty', null, ''],
    ['comma', 'Sara, Ltd', '"Sara, Ltd"'],
    ['quote', 'She said "ok"', '"She said ""ok"""'],
    ['line break', 'a\r\nb', '"a\r\nb"'],
    [
      'formula',
      '=HYPERLINK("http://x","y")',
      '"\'=HYPERLINK(""http://x"",""y"")"',
    ],
    ['plus', '+201001234567', "'+201001234567"],
    ['minus', '-5', "'-5"],
    ['at', '@SUM(A1)', "'@SUM(A1)"],
    ['leading tab', '\tx', "'\tx"],
    ['leading carriage return', '\rx', '"\'\rx"'],
    ['formula later in text', 'a=b', 'a=b'],
  ])('escapes %s', (_label, value, expected) => {
    expect(escapeCsvCell(value)).toBe(expected);
  });

  it('writes CRLF lines after a UTF-8 BOM', () => {
    expect(toCsvLine(['a', 'b'])).toBe('a,b\r\n');
    expect(
      toCsv([
        ['h1', 'h2'],
        ['1', '2'],
      ]),
    ).toBe(`${UTF8_BOM}h1,h2\r\n1,2\r\n`);
    expect(Buffer.from(toCsv([['x']]), 'utf8').subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });

  it('round-trips Arabic and escaped cells through a spreadsheet reader', () => {
    const rows = [
      ['الاسم', 'ملاحظات'],
      ['أحمد علي', 'سطر أول\r\nسطر ثاني'],
      ['=1+1', 'قال "حسنا", ثم ذهب'],
    ];
    const book = read(Buffer.from(toCsv(rows), 'utf8'), {
      type: 'buffer',
      raw: true,
    });
    const parsed = utils.sheet_to_json<string[]>(
      book.Sheets[book.SheetNames[0]],
      {
        header: 1,
        raw: false,
      },
    );
    expect(parsed).toEqual([
      ['الاسم', 'ملاحظات'],
      ['أحمد علي', 'سطر أول\r\nسطر ثاني'],
      ["'=1+1", 'قال "حسنا", ثم ذهب'],
    ]);
  });
});
