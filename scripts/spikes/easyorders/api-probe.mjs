#!/usr/bin/env node

// EasyOrders public API probes for the US-06-01 spike. Every call hits the
// live EasyOrders API with the key in the environment, so the product owner
// runs these against an authorized test store.
//
//   node scripts/spikes/easyorders/api-probe.mjs get-order [orderId]
//   node scripts/spikes/easyorders/api-probe.mjs set-status <status> [orderId]
//   node scripts/spikes/easyorders/api-probe.mjs bad-key [orderId]
//   node scripts/spikes/easyorders/api-probe.mjs no-key [orderId]
//   node scripts/spikes/easyorders/api-probe.mjs discover
//   node scripts/spikes/easyorders/api-probe.mjs delete-webhook <url> --auth api-key|bearer
//
// Add `--key 2` to use EO_API_KEY_2 (a second store or a second key).
// Add `--note "text"` to label the evidence line.
//
// Output is printed and appended to .tmp/spikes/easyorders/api.jsonl with
// credentials fingerprinted and customer fields masked.
//
// Env: EO_API_KEY, EO_API_KEY_2 (optional), EO_ORDER_ID (default order).

import {
  apiKeyFor,
  appendEvidence,
  callApi,
  fingerprint,
  parseArgs,
  requireEnv,
} from './lib.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
const keySlot = flags.key === '2' ? '2' : '1';
const INTERESTING = /currency|country|phone|locale|lang|timezone/i;

function orderId(value) {
  return value ?? requireEnv('EO_ORDER_ID');
}

function findInteresting(value, trail = '', found = []) {
  if (Array.isArray(value)) {
    value
      .slice(0, 3)
      .forEach((item, index) =>
        findInteresting(item, `${trail}[${index}]`, found),
      );
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const next = trail ? `${trail}.${key}` : key;
      if (
        INTERESTING.test(key) &&
        (child === null || typeof child !== 'object')
      ) {
        found.push(
          /phone/i.test(key) && typeof child === 'string'
            ? `${next} = <${child.length} chars, starts "${child.slice(0, 3)}">`
            : `${next} = ${JSON.stringify(child)}`,
        );
      }
      findInteresting(child, next, found);
    }
  }
  return found;
}

function report(result, extra = {}) {
  const { raw, ...safe } = result;
  const record = {
    command,
    keySlot,
    keyFp: extra.keyFp ?? null,
    note: typeof flags.note === 'string' ? flags.note : undefined,
    ...safe,
    topLevelKeys:
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.keys(raw)
        : undefined,
    localeFields: findInteresting(raw),
  };
  appendEvidence('api.jsonl', record);
  console.log(JSON.stringify(record, null, 2));
}

switch (command) {
  case 'get-order': {
    const key = apiKeyFor(keySlot);
    report(
      await callApi({
        apiPath: `orders/${orderId(rest[0])}`,
        headers: { 'Api-Key': key },
      }),
      { keyFp: fingerprint(key) },
    );
    break;
  }
  case 'set-status': {
    if (!rest[0]) {
      console.error('Usage: api-probe.mjs set-status <status> [orderId]');
      process.exit(1);
    }
    const key = apiKeyFor(keySlot);
    report(
      await callApi({
        method: 'PATCH',
        apiPath: `orders/${orderId(rest[1])}/status`,
        headers: { 'Api-Key': key },
        body: { status: rest[0] },
      }),
      { keyFp: fingerprint(key) },
    );
    break;
  }
  case 'bad-key':
    report(
      await callApi({
        apiPath: `orders/${orderId(rest[0])}`,
        headers: { 'Api-Key': 'akeed-spike-not-a-real-key' },
      }),
    );
    break;
  case 'no-key':
    report(await callApi({ apiPath: `orders/${orderId(rest[0])}` }));
    break;
  case 'discover': {
    // Undocumented guesses: looking for an authoritative store currency and
    // country. A 404 on all of them is itself a finding.
    const key = apiKeyFor(keySlot);
    const candidates = [
      'store',
      'stores',
      'settings',
      'orders?limit=1',
      'products?limit=1',
      'shipping_areas',
      'countries',
    ];
    for (const apiPath of candidates) {
      report(await callApi({ apiPath, headers: { 'Api-Key': key } }), {
        keyFp: fingerprint(key),
      });
    }
    break;
  }
  case 'delete-webhook': {
    if (!rest[0]) {
      console.error(
        'Usage: api-probe.mjs delete-webhook <url> --auth api-key|bearer',
      );
      process.exit(1);
    }
    const key = apiKeyFor(keySlot);
    const headers =
      flags.auth === 'bearer'
        ? { Authorization: `Bearer ${key}` }
        : { 'Api-Key': key };
    const result = await callApi({
      method: 'DELETE',
      apiPath: `webhooks/delete-by-url?url=${encodeURIComponent(rest[0])}`,
      headers,
    });
    // The webhook URL carries the spike token; keep it out of the evidence.
    result.path = 'webhooks/delete-by-url?url=<redacted>';
    report(result, { keyFp: fingerprint(key) });
    break;
  }
  default:
    console.error(
      'Commands: get-order, set-status, bad-key, no-key, discover, delete-webhook',
    );
    process.exit(1);
}
