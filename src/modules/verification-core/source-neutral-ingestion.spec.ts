import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function productionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return productionFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * The verification core decides, sends and bills the same way for every
 * Standalone channel. How an order arrived (manual form, file import, later
 * the API) and whether it was ever held is envelope and event metadata the
 * core must never branch on.
 */
describe('verification core is ingestion-channel neutral', () => {
  it('never references ingestion channels, holds or import batches', () => {
    const offenders = productionFiles(__dirname).flatMap((path) => {
      const matches = readFileSync(path, 'utf8').match(
        /bulk_import|hold_group|holdGroup|importBatch|ingestionType/g,
      );
      return matches
        ? [`${relative(__dirname, path)}: ${[...new Set(matches)].join(', ')}`]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});
