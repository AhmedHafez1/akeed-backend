#!/usr/bin/env node

// Capture server for the US-06-01 EasyOrders validation spike.
//
// Receives the authorized-app callback and both webhooks behind a public
// tunnel and records what EasyOrders actually sends. Not production code.
//
//   node scripts/spikes/easyorders/capture-server.mjs
//
// Routes (token in the path, or in `?t=` for the query-survival test):
//   POST /cb/:token       authorized-app callback
//   POST /orders/:token   order-created webhook
//   POST /status/:token   order-status webhook
//   GET  /done/:token     redirect_url landing page
//   GET  /icon.png        app icon for the install page
//   POST /_mode?next=500,slow,200   loopback only: queue the next responses
//
// Evidence goes to .tmp/spikes/easyorders/capture.jsonl. API keys, the
// `secret` header and URL tokens are never written; a fingerprint is.
//
// Env: EO_CAPTURE_PORT (3199), EO_SLOW_MS (35000), EO_WEBHOOK_SECRET
// (optional; when set, the `secret` header is compared against it).

import { createServer } from 'node:http';
import {
  appendEvidence,
  describeSecret,
  fingerprint,
  loadTokens,
  redact,
  safeEqual,
} from './lib.mjs';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.EO_CAPTURE_PORT ?? 3199);
const SLOW_MS = Number(process.env.EO_SLOW_MS ?? 35_000);
const EXPECTED_SECRET = process.env.EO_WEBHOOK_SECRET?.trim() || null;
const KINDS = new Set(['cb', 'orders', 'status', 'done']);
const SAFE_HEADERS = [
  'content-type',
  'content-length',
  'user-agent',
  'x-forwarded-for',
  'origin',
];
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let sequence = 0;
const responseQueue = [];

function isLoopback(request) {
  const address = request.socket.remoteAddress ?? '';
  return (
    !request.headers['x-forwarded-for'] &&
    (address === '127.0.0.1' ||
      address === '::1' ||
      address.endsWith(':127.0.0.1'))
  );
}

function classifyToken(token) {
  if (!token) return { state: 'missing', label: null };
  for (const [label, entry] of Object.entries(loadTokens())) {
    if (safeEqual(entry.token, token)) {
      return { state: entry.revoked ? 'revoked' : 'valid', label };
    }
  }
  return { state: 'wrong', label: null };
}

function classifySecret(header) {
  if (header === undefined) return { state: 'absent' };
  const described = describeSecret(String(header));
  if (!EXPECTED_SECRET) return { state: 'present_unchecked', ...described };
  return {
    state: safeEqual(header, EXPECTED_SECRET) ? 'match' : 'mismatch',
    ...described,
  };
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function decideStatus(kind, token, secret) {
  if (kind === 'done') return { status: 200, mode: 'page' };
  if (token.state !== 'valid')
    return { status: 401, mode: `token_${token.state}` };
  if (secret.state === 'mismatch')
    return { status: 401, mode: 'secret_mismatch' };
  const queued = responseQueue.shift();
  if (!queued) return { status: 200, mode: 'default' };
  if (queued === 'slow') return { status: 200, mode: 'slow', delayMs: SLOW_MS };
  return { status: Number(queued), mode: `queued_${queued}` };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://capture.local');
  const [, kind, pathToken] = url.pathname.split('/');

  if (request.method === 'GET' && url.pathname === '/icon.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' }).end(ICON);
    return;
  }

  if (url.pathname === '/_mode') {
    if (!isLoopback(request)) {
      response.writeHead(404).end();
      return;
    }
    const next = (url.searchParams.get('next') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item === 'slow' || /^[1-5]\d\d$/.test(item));
    responseQueue.length = 0;
    responseQueue.push(...next);
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ queued: responseQueue }));
    return;
  }

  if (!KINDS.has(kind)) {
    response.writeHead(404).end();
    return;
  }

  const receivedAt = new Date().toISOString();
  const rawBody = await readBody(request);
  const rawToken = pathToken ?? url.searchParams.get('t') ?? '';
  const token = classifyToken(rawToken);
  const secret = classifySecret(request.headers.secret);
  const decision = decideStatus(kind, token, secret);

  let body;
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null;
  } catch {
    body = { nonJson: true, length: rawBody.length };
  }

  sequence += 1;
  const record = {
    seq: sequence,
    receivedAt,
    kind,
    method: request.method,
    path: `/${kind}/${pathToken ? '<token>' : ''}`,
    tokenIn: pathToken ? 'path' : url.searchParams.has('t') ? 'query' : 'none',
    token: { ...token, fp: fingerprint(rawToken) },
    queryKeys: [...url.searchParams.keys()],
    query: redact(
      Object.fromEntries(
        [...url.searchParams].filter(([name]) => name !== 't'),
      ),
    ),
    headerNames: Object.keys(request.headers).sort(),
    headers: Object.fromEntries(
      SAFE_HEADERS.filter((name) => request.headers[name] !== undefined).map(
        (name) => [name, request.headers[name]],
      ),
    ),
    secretHeader: secret,
    bodySha256: createHash('sha256').update(rawBody).digest('hex'),
    bodyBytes: rawBody.length,
    body: redact(body),
    responded: decision,
  };
  appendEvidence('capture.jsonl', record);
  console.log(
    `#${record.seq} ${receivedAt} ${request.method} ${record.path} token=${token.state}` +
      `${token.label ? `(${token.label})` : ''} secret=${secret.state} -> ${decision.status} [${decision.mode}]`,
  );

  if (decision.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
  }
  if (kind === 'done') {
    response
      .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Akeed spike: install flow returned here. You can close this tab.');
    return;
  }
  response
    .writeHead(decision.status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ ok: decision.status < 300 }));
});

server.listen(PORT, () => {
  console.log(
    `EasyOrders capture server listening on http://localhost:${PORT}`,
  );
  console.log(
    EXPECTED_SECRET
      ? 'EO_WEBHOOK_SECRET is set: the secret header is checked.'
      : 'EO_WEBHOOK_SECRET is not set: the secret header is recorded, not checked.',
  );
});
