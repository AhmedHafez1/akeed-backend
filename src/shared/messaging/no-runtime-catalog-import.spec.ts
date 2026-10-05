import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * US-08-03: the template registry is the source of what Akeed sends. The code
 * catalog stays in the repository until the US-08-08 gate as the seed source
 * and the characterization baseline, and nothing at runtime may read it.
 */
const SRC_ROOT = resolve(__dirname, '../..');
const CATALOG_IMPORT = /from\s+'[^']*cod-template-catalog'/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function isTestOnly(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.endsWith('.spec.ts') || normalized.includes('/testing/');
}

describe('the code template catalog', () => {
  it('is imported by specs and test helpers only', () => {
    const runtimeImporters = sourceFiles(SRC_ROOT)
      .filter((path) => !isTestOnly(path))
      .filter((path) => CATALOG_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC_ROOT, path).replace(/\\/g, '/'));

    expect(runtimeImporters).toEqual([]);
  });
});
