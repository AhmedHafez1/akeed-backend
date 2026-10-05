import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { SUPPORTED_PLATFORM_TYPES } from '../../shared/interfaces/commerce-source.interface';

/**
 * A store platform's own code lives in its spoke
 * (`src/infrastructure/spokes/<platform>`): its normalizer, guards, adapters
 * and handlers. A file named after a store platform under `src/modules` or
 * `src/shared/guards` is that code in the wrong place.
 *
 * Standalone is Akeed's own source, not a provider, so its files are core.
 * `src/shared/config` is not scanned: a spoke's typed config is parsed in
 * `validateEnv` and belongs there.
 */
const STORE_PLATFORMS = SUPPORTED_PLATFORM_TYPES.filter(
  (platform) => platform !== 'standalone',
);

const SRC = resolve(__dirname, '..', '..');
const SCANNED = ['modules', 'shared/guards'];

/** Path from `src`, with the reason it may stay. Empty on purpose. */
const ALLOWED: Record<string, string> = {};

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function platformNamedFiles(): string[] {
  return SCANNED.flatMap((directory) => filesUnder(resolve(SRC, directory)))
    .filter((path) => {
      const name = path.split(/[\\/]/).pop()!.toLowerCase();
      return STORE_PLATFORMS.some((platform) => name.includes(platform));
    })
    .map((path) => relative(SRC, path).split('\\').join('/'));
}

describe('spoke boundary', () => {
  it('covers every store platform the schema allows', () => {
    expect(STORE_PLATFORMS).toEqual(
      expect.arrayContaining(['shopify', 'easyorders', 'woocommerce']),
    );
    expect(STORE_PLATFORMS).not.toContain('standalone');
  });

  it('keeps files named after a store platform inside that platform spoke', () => {
    const misplaced = platformNamedFiles().filter(
      (path) => !Object.hasOwn(ALLOWED, path),
    );

    expect(misplaced).toEqual([]);
  });

  it('has no allowlist entry for a file that is gone', () => {
    const present = new Set(platformNamedFiles());

    expect(Object.keys(ALLOWED).filter((path) => !present.has(path))).toEqual(
      [],
    );
  });
});
