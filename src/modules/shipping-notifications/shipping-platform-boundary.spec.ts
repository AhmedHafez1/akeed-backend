import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory()
      ? productionFiles(file)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [file]
        : [];
  });
}

/**
 * The shipping core reads store events only through `SHIPPING_EVENT_SOURCES`.
 * A platform is added as a spoke source plus one binding, never as a branch
 * or an import here.
 */
describe('platform-neutral shipping core', () => {
  const files = productionFiles(resolve(__dirname));

  it('has production files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports no spoke', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(
      /spokes[\\/]|ShopifyApiService/,
    );
  });

  it.each(files)('%s has no platform branch or platform name', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/platform(?:Type)?\s*[=!]==/);
    expect(source).not.toMatch(
      /'(shopify|standalone|salla|zid|woocommerce|easyorders)'/i,
    );
  });
});
