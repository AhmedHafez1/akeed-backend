import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drizzle's migrator runs only journal entries whose `when` is later than the
 * newest `created_at` already recorded in the database, and logs success for
 * the rest. An entry dated earlier than its predecessor is skipped silently
 * everywhere that predecessor has already run.
 */
describe('migration journal', () => {
  const drizzleDir = resolve(__dirname, '../../../drizzle');
  const { entries } = JSON.parse(
    readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; when: number; tag: string }[] };

  it('dates every entry after the one before it', () => {
    const outOfOrder = entries
      .slice(1)
      .filter((entry, index) => entry.when <= entries[index].when)
      .map((entry) => entry.tag);
    expect(outOfOrder).toEqual([]);
  });

  it('has a SQL file for every entry', () => {
    const missing = entries
      .filter((entry) => !existsSync(resolve(drizzleDir, `${entry.tag}.sql`)))
      .map((entry) => entry.tag);
    expect(missing).toEqual([]);
  });
});
