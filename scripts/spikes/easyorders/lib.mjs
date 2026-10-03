// Shared helpers for the US-06-01 EasyOrders validation spike.
//
// Nothing here is production code. Credentials come from the environment only
// and are never written to disk: evidence keeps a short SHA-256 fingerprint so
// two values can be compared (same key? same secret?) without storing either.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const EVIDENCE_DIR = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  '.tmp',
  'spikes',
  'easyorders',
);
export const TOKENS_FILE = path.join(EVIDENCE_DIR, 'tokens.json');
export const API_BASE = 'https://api.easy-orders.net/api/v1/external-apps';

const SECRET_KEY = /secret|api[-_]?key|token|password|authorization/i;
const PII_KEY = /^(full_name|name|phone|address|email|notes?|ip)$/i;

export function ensureEvidenceDir() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`Missing environment variable ${name}`);
    process.exit(1);
  }
  return value.trim();
}

export function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function describeSecret(value) {
  if (typeof value !== 'string') return { present: false };
  return { present: true, length: value.length, fp: fingerprint(value) };
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

// Replaces credential-looking values with a fingerprint at any depth. With
// `maskPii`, customer fields are reduced to their shape as well.
export function redact(value, { maskPii = false } = {}, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, { maskPii }, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redact(child, { maskPii }, childKey),
      ]),
    );
  }
  if (SECRET_KEY.test(key) && value !== null && value !== undefined) {
    return { redacted: true, ...describeSecret(String(value)) };
  }
  if (maskPii && PII_KEY.test(key) && typeof value === 'string') {
    return `<${key}:${value.length} chars>`;
  }
  return value;
}

export function appendEvidence(fileName, record) {
  ensureEvidenceDir();
  appendFileSync(
    path.join(EVIDENCE_DIR, fileName),
    `${JSON.stringify(record)}\n`,
  );
}

export function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return {};
  return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
}

export function saveTokens(tokens) {
  ensureEvidenceDir();
  writeFileSync(TOKENS_FILE, `${JSON.stringify(tokens, null, 2)}\n`);
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { flags, positional };
}

export function apiKeyFor(which) {
  return requireEnv(which === '2' ? 'EO_API_KEY_2' : 'EO_API_KEY');
}

const RATE_HEADER = /rate|retry|limit|remaining|reset/i;

// One bounded call to the EasyOrders public API. Returns evidence that is safe
// to print: no request credentials, response credentials fingerprinted,
// customer fields masked.
export async function callApi({
  method = 'GET',
  apiPath,
  headers = {},
  body,
  timeoutMs = 15_000,
}) {
  const startedAt = Date.now();
  const url = `${API_BASE}/${apiPath.replace(/^\//, '')}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const headerNames = [...response.headers.keys()];
    return {
      at: new Date(startedAt).toISOString(),
      method,
      path: apiPath,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      headerNames,
      rateHeaders: Object.fromEntries(
        headerNames
          .filter((name) => RATE_HEADER.test(name))
          .map((name) => [name, response.headers.get(name)]),
      ),
      body:
        parsed === undefined
          ? { nonJson: true, length: text.length, head: text.slice(0, 200) }
          : redact(parsed, { maskPii: true }),
      raw: parsed,
    };
  } catch (error) {
    return {
      at: new Date(startedAt).toISOString(),
      method,
      path: apiPath,
      status: null,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.name : 'unknown',
    };
  }
}
