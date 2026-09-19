import type { GridRow } from './grid.types';
import { normalizeGrid } from './header-normalizer';

const limits = { maxRows: 5_000, maxColumns: 100 };

function rows(...lines: string[][]): GridRow[] {
  return lines.map((cells, index) => ({
    rowNumber: index + 1,
    cells,
    issues: [],
  }));
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('normalizeGrid', () => {
  it('takes the first non-empty row as the header, trimmed and NFC-normalized', () => {
    const decomposed = `Cafe${String.fromCharCode(0x301)}`;
    const grid = normalizeGrid(
      [
        { rowNumber: 1, cells: ['', '  '], issues: [] },
        { rowNumber: 2, cells: [`  ${decomposed} `, ' phone '], issues: [] },
        { rowNumber: 3, cells: [' x ', ' 0100 '], issues: [] },
      ],
      limits,
    );
    expect(grid.headers).toEqual([decomposed.normalize('NFC'), 'phone']);
    expect(grid.headers[0]).toHaveLength(4);
    expect(grid.rows).toEqual([
      { rowNumber: 3, cells: ['x', '0100'], issues: [] },
    ]);
  });

  it('names blank headers by spreadsheet column and suffixes duplicates', () => {
    const grid = normalizeGrid(
      rows(['name', '', 'name', 'name', 'Column 2'], ['a', 'b', 'c', 'd', 'e']),
      limits,
    );
    expect(grid.headers).toEqual([
      'name',
      'Column 2',
      'name (2)',
      'name (3)',
      'Column 2 (2)',
    ]);
  });

  it('keeps extra cells under Column N and fills missing cells', () => {
    const grid = normalizeGrid(
      rows(['a', 'b'], ['1'], ['1', '2', '3']),
      limits,
    );
    expect(grid.headers).toEqual(['a', 'b', 'Column 3']);
    expect(grid.rows.map((row) => row.cells)).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('drops columns with neither a header nor a value', () => {
    const grid = normalizeGrid(
      rows(['a', '', 'b', ''], ['1', ' ', '2', '']),
      limits,
    );
    expect(grid.headers).toEqual(['a', 'b']);
    expect(grid.rows[0].cells).toEqual(['1', '2']);
  });

  it('truncates values over 1,000 characters and flags the field', () => {
    const grid = normalizeGrid(
      rows(['note'], ['x'.repeat(1_000)], ['y'.repeat(1_001)]),
      limits,
    );
    expect(grid.rows[0]).toEqual({
      rowNumber: 2,
      cells: ['x'.repeat(1_000)],
      issues: [],
    });
    expect(grid.rows[1]).toEqual({
      rowNumber: 3,
      cells: ['y'.repeat(1_000)],
      issues: [{ code: 'FIELD_TOO_LONG', field: 'note' }],
    });
  });

  it('never splits a surrogate pair when truncating', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const grid = normalizeGrid(
      rows(['note'], ['a' + emoji.repeat(600)]),
      limits,
    );
    expect(grid.rows[0].cells[0]).toHaveLength(999);
  });

  it('keeps parser issues on their row', () => {
    const grid = normalizeGrid(
      [
        { rowNumber: 1, cells: ['a'], issues: [] },
        {
          rowNumber: 2,
          cells: ['x'],
          issues: [{ code: 'CSV_MALFORMED_QUOTE' }],
        },
      ],
      limits,
    );
    expect(grid.rows[0].issues).toEqual([{ code: 'CSV_MALFORMED_QUOTE' }]);
  });

  it.each([
    ['no rows', [] as string[][], 'IMPORT_FILE_EMPTY'],
    ['only blank rows', [['', ' ']], 'IMPORT_FILE_EMPTY'],
    ['a header only', [['a', 'b']], 'IMPORT_FILE_EMPTY'],
  ])('refuses %s', (_label, lines, code) => {
    expect(codeOf(() => normalizeGrid(rows(...lines), limits))).toBe(code);
  });

  it('enforces the row and column limits at their boundaries', () => {
    const header = Array.from({ length: 3 }, (_, index) => `c${index}`);
    expect(
      normalizeGrid(rows(header, ['1'], ['2']), { maxRows: 2, maxColumns: 3 })
        .rows,
    ).toHaveLength(2);
    expect(
      codeOf(() =>
        normalizeGrid(rows(header, ['1'], ['2'], ['3']), {
          maxRows: 2,
          maxColumns: 3,
        }),
      ),
    ).toBe('IMPORT_ROW_LIMIT_EXCEEDED');
    expect(
      codeOf(() =>
        normalizeGrid(rows(header, ['1', '2', '3', '4']), {
          maxRows: 2,
          maxColumns: 3,
        }),
      ),
    ).toBe('IMPORT_COLUMN_LIMIT_EXCEEDED');
  });
});
