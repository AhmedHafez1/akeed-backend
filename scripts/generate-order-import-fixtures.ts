/**
 * Regenerates test/fixtures/order-imports: one file per quirk plus
 * `<file>.expected.json` (the parsed grid) and, for the US-04.6-10 release
 * gate pack, `<file>.manifest.json` (every row's outcome and issue codes).
 * Run with `npm run fixtures:order-imports`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ORDER_IMPORT_FIXTURES } from './order-import-fixtures/build-fixtures';
import { RELEASE_GATE_FIXTURES } from './order-import-fixtures/release-gate-fixtures';

const directory = resolve(__dirname, '../test/fixtures/order-imports');
mkdirSync(directory, { recursive: true });

const index: {
  file: string;
  description: string;
  bytes: number;
  manifest: boolean;
}[] = [];
for (const fixture of [...ORDER_IMPORT_FIXTURES, ...RELEASE_GATE_FIXTURES]) {
  const bytes = fixture.build();
  writeFileSync(join(directory, fixture.file), bytes);
  writeFileSync(
    join(directory, `${fixture.file}.expected.json`),
    `${JSON.stringify(fixture.expected, null, 2)}\n`,
  );
  if (fixture.manifest)
    writeFileSync(
      join(directory, `${fixture.file}.manifest.json`),
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
    );
  index.push({
    file: fixture.file,
    description: fixture.description,
    bytes: bytes.length,
    manifest: !!fixture.manifest,
  });
}
writeFileSync(
  join(directory, 'index.json'),
  `${JSON.stringify(index, null, 2)}\n`,
);
console.log(`Wrote ${index.length} order-import fixtures to ${directory}`);
