#!/usr/bin/env node

// Turns one captured webhook into a committable fixture for the US-06-01
// spike: synthetic IDs, no customer data, no secrets, key order preserved.
//
//   node scripts/spikes/easyorders/sanitize-fixture.mjs --seq 4 --out test/fixtures/easyorders/order-created.json
//   node scripts/spikes/easyorders/sanitize-fixture.mjs --seq 4            (prints only)
//
// `--seq` is the `seq` of a line in .tmp/spikes/easyorders/capture.jsonl.
// The script lists every string it kept unchanged; read that list before
// committing the fixture.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR, parseArgs } from './lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const source =
  typeof flags.file === 'string'
    ? flags.file
    : path.join(EVIDENCE_DIR, 'capture.jsonl');
const seq = Number(flags.seq);

const line = readFileSync(source, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((text) => JSON.parse(text))
  .findLast((record) => record.seq === seq);
if (!line) {
  console.error(`No capture with seq ${flags.seq} in ${source}`);
  process.exit(1);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DROP = /secret|api[-_]?key|token|password|authorization/i;
const uuids = new Map();
const kept = [];
let counter = 0;

function syntheticUuid(real) {
  const known = uuids.get(real.toLowerCase());
  if (known) return known;
  const next = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`;
  uuids.set(real.toLowerCase(), next);
  return next;
}

// Keeps the shape that matters to phone normalization (prefix and length)
// while discarding the subscriber number.
function syntheticPhone(real) {
  let seen = 0;
  return real.replace(/\d/g, (digit) => {
    seen += 1;
    return seen <= 3 ? digit : '0';
  });
}

function sanitizeString(key, value, trail) {
  if (/phone|mobile|whatsapp/i.test(key)) return syntheticPhone(value);
  if (/^(full_name|customer_name|first_name|last_name)$/i.test(key))
    return 'Test Customer';
  if (/address|street|notes?$|comment/i.test(key)) return 'Synthetic address 1';
  if (/email/i.test(key)) return 'customer@example.com';
  if (/^ip|_ip$/i.test(key)) return '203.0.113.10';
  if (/^name$|title/i.test(key)) {
    counter += 1;
    return `Sample item ${counter}`;
  }
  if (/sku|code|ref/i.test(key)) {
    counter += 1;
    return `SYNTHETIC-${String(counter).padStart(4, '0')}`;
  }
  if (/url|image|thumb|link|slug/i.test(key)) return 'https://example.com/x';
  if (ISO_TIME.test(value)) {
    return value.replace(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?/,
      '2026-01-01T12:00:00.000000',
    );
  }
  const replaced = value.replace(UUID, (match) => syntheticUuid(match));
  if (replaced === value && value.length > 0)
    kept.push(`${trail} = ${JSON.stringify(value)}`);
  return replaced;
}

function sanitize(value, key = '', trail = '') {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitize(item, key, `${trail}[${index}]`),
    );
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (DROP.test(childKey)) continue;
      out[childKey] = sanitize(
        child,
        childKey,
        trail ? `${trail}.${childKey}` : childKey,
      );
    }
    return out;
  }
  if (typeof value === 'string') return sanitizeString(key, value, trail);
  return value;
}

const fixture = {
  _fixture: {
    source: 'EasyOrders webhook captured for US-06-01, then sanitized',
    kind: line.kind,
    capturedOn: line.receivedAt.slice(0, 10),
    synthetic:
      'IDs, customer fields, product names and timestamps are synthetic',
    headerNames: line.headerNames,
    secretHeader: line.secretHeader.state === 'absent' ? 'absent' : 'present',
  },
  payload: sanitize(line.body),
};

const output = `${JSON.stringify(fixture, null, 2)}\n`.replace(/\n/g, '\r\n');
console.error('Strings kept unchanged (review before committing):');
for (const entry of kept) console.error(`  ${entry}`);

if (typeof flags.out === 'string') {
  mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
  writeFileSync(flags.out, output);
  console.error(`\nWrote ${flags.out}`);
} else {
  process.stdout.write(output);
}
