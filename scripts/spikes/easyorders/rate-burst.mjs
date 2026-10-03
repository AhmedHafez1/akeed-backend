#!/usr/bin/env node

// Rate-limit burst for the US-06-01 spike: who does the documented
// 40 requests/minute apply to, and what does a 429 look like? Calls the live
// EasyOrders API, so the product owner runs it against a test store.
//
//   node scripts/spikes/easyorders/rate-burst.mjs --count 60 --interval-ms 500
//   node scripts/spikes/easyorders/rate-burst.mjs --count 80 --interval-ms 500 --keys both
//   node scripts/spikes/easyorders/rate-burst.mjs --count 60 --keys 2
//
// `--keys both` alternates EO_API_KEY and EO_API_KEY_2. If each key gets its
// own 40, the limit is per key; if the pair shares 40, it is wider (store,
// app or IP, depending on what the two keys have in common).
//
// The burst stops at the first 429 unless `--keep-going` is set, then polls
// every 5 s until the key is accepted again and reports the recovery time.
//
// Env: EO_API_KEY, EO_API_KEY_2 (for --keys 2|both), EO_ORDER_ID.

import {
  apiKeyFor,
  appendEvidence,
  callApi,
  fingerprint,
  parseArgs,
  requireEnv,
} from './lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const count = Number(flags.count ?? 60);
const intervalMs = Number(flags['interval-ms'] ?? 500);
const mode = ['2', 'both'].includes(flags.keys) ? flags.keys : '1';
const slots = mode === 'both' ? ['1', '2'] : [mode];
const keys = Object.fromEntries(slots.map((slot) => [slot, apiKeyFor(slot)]));
const apiPath = `orders/${requireEnv('EO_ORDER_ID')}`;
const runId = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(slot, index) {
  const { raw, body, headerNames, ...result } = await callApi({
    apiPath,
    headers: { 'Api-Key': keys[slot] },
  });
  const record = {
    runId,
    index,
    keySlot: slot,
    keyFp: fingerprint(keys[slot]),
    ...result,
    ...(result.status === 429 ? { headerNames, body } : {}),
  };
  appendEvidence('rate.jsonl', record);
  return record;
}

const startedAt = Date.now();
const firstLimited = {};
const accepted = Object.fromEntries(slots.map((slot) => [slot, 0]));

for (let index = 0; index < count; index += 1) {
  const slot = slots[index % slots.length];
  const record = await probe(slot, index);
  const offset = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `${String(index).padStart(3)} +${offset}s key${slot} -> ${record.status ?? record.error}` +
      `${Object.keys(record.rateHeaders ?? {}).length ? ` ${JSON.stringify(record.rateHeaders)}` : ''}`,
  );
  if (record.status === 429) {
    firstLimited[slot] ??= {
      index,
      afterAccepted: accepted[slot],
      atMs: Date.now() - startedAt,
      headerNames: record.headerNames,
      rateHeaders: record.rateHeaders,
      body: record.body,
    };
    if (!flags['keep-going']) break;
  } else if (record.status !== null && record.status < 400) {
    accepted[slot] += 1;
  }
  await sleep(intervalMs);
}

const recovery = {};
for (const slot of Object.keys(firstLimited)) {
  const limitedAt = Date.now();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(5_000);
    const record = await probe(slot, `recover-${attempt}`);
    if (record.status !== 429) {
      recovery[slot] = {
        status: record.status,
        secondsAfterBurstEnd: Math.round((Date.now() - limitedAt) / 1000),
      };
      break;
    }
  }
  recovery[slot] ??= { status: 429, secondsAfterBurstEnd: '>150' };
}

const summary = {
  runId,
  summary: true,
  mode,
  count,
  intervalMs,
  accepted,
  firstLimited,
  recovery,
};
appendEvidence('rate.jsonl', summary);
console.log(JSON.stringify(summary, null, 2));
