import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKEND = resolve(__dirname, '../../..');
const TABLE = resolve(
  BACKEND,
  'docs/Epics/04.6-standalone-bulk-order-import/release-gate-traceability.json',
);
const EPIC = resolve(
  BACKEND,
  'docs/Epics/04.6-standalone-bulk-order-import/README.md',
);

interface Coverage {
  file: string;
  test: string;
  case?: string;
}

interface Entry {
  id: string;
  section?: string;
  entry: string;
  coverage?: Coverage[];
  pilot?: string;
}

const table = JSON.parse(readFileSync(TABLE, 'utf8')) as {
  catalogue: Entry[];
  invariants: Entry[];
};

/** The epic's edge-case catalogue, one bullet per line, by section. */
function catalogueBullets(): { section: string; bullets: number }[] {
  const readme = readFileSync(EPIC, 'utf8').replace(/\r\n/g, '\n');
  const start = readme.indexOf('## Edge-case catalogue');
  const end = readme.indexOf('\n## ', start + 1);
  const sections: { section: string; bullets: number }[] = [];
  for (const line of readme.slice(start, end).split('\n')) {
    const heading = /^\*\*(.+?)\*\*/.exec(line);
    if (heading) sections.push({ section: heading[1], bullets: 0 });
    else if (line.startsWith('- ') && sections.length > 0)
      sections[sections.length - 1].bullets += 1;
  }
  return sections;
}

/**
 * US-04.6-10: every edge-case catalogue entry and failure invariant of the
 * epic maps to a test that still exists (or a pilot checklist item). An
 * unmapped entry, a renamed test or a dropped table case fails the gate.
 */
describe('E04.6 release gate: traceability of the edge-case catalogue', () => {
  const entries = [...table.catalogue, ...table.invariants];

  it('covers every section of the catalogue, with at least one entry per bullet', () => {
    for (const { section, bullets } of catalogueBullets()) {
      const mapped = table.catalogue.filter(
        (entry) => entry.section === section,
      );
      expect({ section, enough: mapped.length >= bullets }).toEqual({
        section,
        enough: true,
      });
    }
    expect(table.invariants).toHaveLength(8);
  });

  it('gives every entry a unique id and a test or a pilot observation', () => {
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const unmapped = entries
      .filter((entry) => !entry.coverage?.length && !entry.pilot)
      .map((entry) => entry.id);
    expect(unmapped).toEqual([]);
  });

  it.each(
    entries.flatMap((entry) =>
      (entry.coverage ?? []).map((coverage) => [entry.id, coverage] as const),
    ),
  )('%s is proven by %j', (_id, coverage) => {
    const path = resolve(BACKEND, coverage.file);
    if (
      coverage.file.startsWith('../akeed-frontend/') &&
      !existsSync(resolve(BACKEND, '../akeed-frontend/package.json'))
    )
      return; // The frontend app is not next to this checkout.
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, 'utf8');
    expect(source).toContain(coverage.test);
    if (coverage.case) expect(source).toContain(coverage.case);
  });
});
