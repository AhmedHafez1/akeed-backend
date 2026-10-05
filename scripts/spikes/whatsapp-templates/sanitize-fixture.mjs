#!/usr/bin/env node

// Turns a saved template list into a committable fixture for US-08-01:
// synthetic template IDs and cursors, no account ID, no token.
// Offline: it reads files and calls nothing.
//
//   node scripts/spikes/whatsapp-templates/sanitize-fixture.mjs --env dev --out test/fixtures/whatsapp-templates/template-list.json
//   node scripts/spikes/whatsapp-templates/sanitize-fixture.mjs --env dev        (prints only)
//
// Names, languages, statuses, categories, quality and component text are kept
// as Meta returned them: they are Akeed's own templates, and they are what
// later tests need. The script lists every string it kept and marks the ones
// that look like an identifier, a phone number, an address or a link. Read
// that list before committing the fixture.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT, evidenceDir, parseArgs } from './lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
if (typeof flags.env !== 'string') {
  console.error(
    'Usage: node scripts/spikes/whatsapp-templates/sanitize-fixture.mjs --env dev|prod [--out <file>]',
  );
  process.exit(1);
}

const source = path.join(evidenceDir(flags.env), 'templates.json');
if (!existsSync(source)) {
  console.error(
    `No run at ${path.relative(BACKEND_ROOT, source)}. Run list-templates.mjs --env ${flags.env} first.`,
  );
  process.exit(1);
}
const run = JSON.parse(readFileSync(source, 'utf8'));

const SUSPICIOUS = /\d{9,}|@|https?:\/\/|www\./i;
const ids = new Map();
const kept = [];

function syntheticId(real) {
  const known = ids.get(String(real));
  if (known) return known;
  const next = String(900000000000001 + ids.size);
  ids.set(String(real), next);
  return next;
}

function sanitize(value, key, trail) {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitize(item, key, `${trail}[${index}]`),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitize(child, childKey, trail ? `${trail}.${childKey}` : childKey),
      ]),
    );
  }
  if (
    key === 'id' &&
    (typeof value === 'string' || typeof value === 'number')
  ) {
    return syntheticId(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    kept.push(
      `${SUSPICIOUS.test(value) ? 'REVIEW ' : '       '}${trail} = ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const fixture = {
  _fixture: {
    source: `GET /${run.meta.graphApiVersion}/<WA_BUSINESS_ACCOUNT_ID>/message_templates, observed for US-08-01, then sanitized`,
    environment: run.meta.env,
    capturedOn: String(run.meta.ranAt).slice(0, 10),
    graphApiVersion: run.meta.graphApiVersion,
    requestedFields: run.meta.requestedFields,
    droppedFields: run.meta.droppedFields,
    synthetic:
      'Template IDs and paging cursors are synthetic. Everything else is as Meta returned it.',
    order:
      'Sorted by name, then language. Meta returned them in another order, over one or more pages.',
  },
  payload: {
    data: run.templates.map((template, index) =>
      sanitize(template, '', `data[${index}]`),
    ),
    paging: {
      cursors: { before: 'SYNTHETIC_BEFORE', after: 'SYNTHETIC_AFTER' },
    },
    ...(run.meta.summary ? { summary: run.meta.summary } : {}),
  },
};

const output = `${JSON.stringify(fixture, null, 2)}\n`.replace(/\n/g, '\r\n');
console.error('Strings kept unchanged (read before committing):');
for (const entry of kept) console.error(`  ${entry}`);
console.error(`\n${ids.size} template ID(s) replaced with synthetic ones.`);

if (typeof flags.out === 'string') {
  mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
  writeFileSync(flags.out, output);
  console.error(`Wrote ${flags.out}`);
} else {
  process.stdout.write(output);
}
