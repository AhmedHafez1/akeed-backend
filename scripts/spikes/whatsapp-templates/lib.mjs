// Shared helpers for the US-08-01 WhatsApp template reconciliation kit.
//
// Nothing here is production code and nothing in `src/` depends on it.
// `graphGet` is the only function that talks to Meta: GET only, a pinned host
// and Graph version, and the token in the Authorization header, never in a URL.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BACKEND_ROOT = path.resolve(HERE, '..', '..', '..');
export const EVIDENCE_ROOT = path.join(
  BACKEND_ROOT,
  '.tmp',
  'spikes',
  'whatsapp-templates',
);

// The version src/infrastructure/spokes/meta/whatsapp.service.ts sends with.
export const GRAPH_API_VERSION = 'v24.0';
export const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const REDACTED = '[REDACTED]';
const LABEL = /^[a-z0-9-]{1,32}$/;

export function evidenceDir(label) {
  if (typeof label !== 'string' || !LABEL.test(label)) {
    throw new Error('The run label must be lowercase letters, digits or "-".');
  }
  return path.join(EVIDENCE_ROOT, label);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns a function that removes every secret from a string: the raw value,
// its URL-encoded form, any `access_token=` parameter and any Bearer header.
export function createScrubber(secrets) {
  const needles = new Set();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    needles.add(secret);
    needles.add(encodeURIComponent(secret));
  }
  const literal = [...needles]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  const secretPattern = literal.length
    ? new RegExp(literal.join('|'), 'g')
    : null;
  return (text) => {
    let next = String(text);
    if (secretPattern) next = next.replace(secretPattern, REDACTED);
    return next
      .replace(/access_token=[^&\s"'<>]+/gi, `access_token=${REDACTED}`)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=|-]+/g, `Bearer ${REDACTED}`);
  };
}

// Applies a scrubber to every string in a JSON-like value, keys included.
export function scrubDeep(value, scrub) {
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        scrub(key),
        scrubDeep(child, scrub),
      ]),
    );
  }
  return typeof value === 'string' ? scrub(value) : value;
}

// SHA-256 over the kit's network-facing sources with line endings normalized,
// so a run can be tied to a commit whatever `core.autocrlf` did on checkout.
export function kitFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['lib.mjs', 'list-templates.mjs']) {
    hash.update(`${name}\n`);
    hash.update(
      readFileSync(path.join(HERE, name), 'utf8').replace(/\r\n/g, '\n'),
    );
  }
  return hash.digest('hex').slice(0, 16);
}

// One bounded, read-only call to the Graph API. The result never carries the
// request, its headers or Meta's trace fields: only the status, and either the
// parsed body or Meta's error code and message.
export async function graphGet({
  apiPath,
  query = {},
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
}) {
  const url = new URL(`${GRAPH_BASE_URL}/${apiPath.replace(/^\/+/, '')}`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(name, String(value));
    }
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    return {
      ok: false,
      status: null,
      error: { code: null, message: `Request did not complete (${name}).` },
    };
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (!response.ok || body?.error || body === undefined) {
    const metaError = body?.error;
    return {
      ok: false,
      status: response.status,
      error: {
        code: Number.isInteger(metaError?.code) ? metaError.code : null,
        message:
          typeof metaError?.message === 'string'
            ? metaError.message
            : 'The response was not a Graph API JSON body.',
      },
    };
  }
  return { ok: true, status: response.status, body };
}
