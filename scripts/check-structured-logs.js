#!/usr/bin/env node
/**
 * CI guardrail: ensures every `this.logger.<level>(...)` call in backend
 * source uses `buildBackendLog(...)` as its argument.
 *
 * Exits 0 when compliant, 1 with a list of violations otherwise.
 *
 * Excluded files:
 *  - *.spec.ts / *.test.ts (test files)
 *  - backend-log.util.ts   (the utility itself)
 *  - migrate.ts             (CLI migration script)
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const EXCLUDE_PATTERNS = [/\.spec\.ts$/, /\.test\.ts$/, /backend-log\.util\.ts$/, /migrate\.ts$/];

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...walk(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

const violations = [];

for (const file of walk(SRC_DIR)) {
  const rel = path.relative(SRC_DIR, file);
  if (EXCLUDE_PATTERNS.some((p) => p.test(rel))) continue;

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/this\.logger\.(log|warn|error|debug|verbose)\(/.test(lines[i])) {
      const window = lines.slice(i, Math.min(i + 6, lines.length)).join(' ');
      if (!/buildBackendLog/.test(window)) {
        violations.push({ file: rel, line: i + 1, code: lines[i].trim() });
      }
    }
  }
}

if (violations.length === 0) {
  console.log('✓ All logger calls use buildBackendLog — 0 violations.');
  process.exit(0);
} else {
  console.error(`✗ Found ${violations.length} non-structured logger call(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.code}`);
  }
  process.exit(1);
}
