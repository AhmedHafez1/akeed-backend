#!/usr/bin/env node
// Read-only probe for the US-07-06 WooCommerce live pilot.
//
// It asks the pilot store what Akeed asks it, with a key the product owner
// made for the probe, and prints the answer with everything personal or
// secret taken out. Akeed's own key cannot be used for this: Akeed holds it
// encrypted and never shows it. The probe only ever sends GET.
//
// Usage (PowerShell), from the backend root:
//   $env:WC_PROBE_STORE_URL = 'https://your-store.example'
//   $env:WC_PROBE_KEY = 'ck_...'      # a Read key made for the probe
//   $env:WC_PROBE_SECRET = 'cs_...'
//   node scripts/woocommerce-pilot-probe.mjs status
//   node scripts/woocommerce-pilot-probe.mjs order 1234
//   node scripts/woocommerce-pilot-probe.mjs notes 1234
//   node scripts/woocommerce-pilot-probe.mjs webhooks
//
// Every answer is printed and appended to .tmp/pilots/woocommerce/api.jsonl
// (gitignored). The key and the secret are never printed or written.
//
// The pilot script (docs/Epics/07-woocommerce-integration/evidence/
// US-07-06-live-pilot-script.md) says when to run each command.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../.tmp/pilots/woocommerce/api.jsonl',
);
const AKEED_MARKER_KEY = 'akeed_outcome';
const KEPT_HEADERS = [
  'content-type',
  'retry-after',
  'x-wp-total',
  'x-wp-totalpages',
  'location',
];

function fail(message) {
  console.error(message);
  process.exit(2);
}

const [command, argument] = process.argv.slice(2);
const storeUrl = (process.env.WC_PROBE_STORE_URL ?? '').replace(/\/+$/, '');
const key = process.env.WC_PROBE_KEY ?? '';
const secret = process.env.WC_PROBE_SECRET ?? '';

if (!/^https:\/\/[^/]+/.test(storeUrl))
  fail('WC_PROBE_STORE_URL must be the https:// address of the pilot store.');
if (!key || !secret) fail('WC_PROBE_KEY and WC_PROBE_SECRET must be set.');

const orderId = () => {
  if (!/^[1-9]\d*$/.test(argument ?? ''))
    fail(`"${command}" needs an order id, for example: ${command} 1234`);
  return argument;
};

const paths = {
  status: () => '/wp-json/wc/v3/system_status',
  order: () => `/wp-json/wc/v3/orders/${orderId()}`,
  notes: () => `/wp-json/wc/v3/orders/${orderId()}/notes`,
  webhooks: () => '/wp-json/wc/v3/webhooks?per_page=100',
};
if (!paths[command])
  fail('Commands: status | order <id> | notes <id> | webhooks');

const isRecord = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Long digit runs and e-mail addresses are taken out of free text. */
const maskText = (text) =>
  String(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]');

/** The delivery URL holds the per-install token: only its end is shown. */
function maskDeliveryUrl(value) {
  if (typeof value !== 'string') return null;
  const cut = value.lastIndexOf('/');
  const token = value.slice(cut + 1);
  return `${value.slice(0, cut + 1)}[token ending ${token.slice(-4)}, ${token.length} characters]`;
}

const sanitize = {
  status(body) {
    const environment = isRecord(body?.environment) ? body.environment : {};
    return {
      home_url: environment.home_url ?? null,
      site_url: environment.site_url ?? null,
      woocommerce_version: environment.version ?? null,
      currency: isRecord(body?.settings)
        ? (body.settings.currency ?? null)
        : null,
    };
  },
  order(body) {
    const billing = isRecord(body?.billing) ? body.billing : {};
    const metaData = Array.isArray(body?.meta_data) ? body.meta_data : [];
    return {
      id: body?.id ?? null,
      id_type: typeof body?.id,
      number: body?.number ?? null,
      status: body?.status ?? null,
      created_via: body?.created_via ?? null,
      currency: body?.currency ?? null,
      total: body?.total ?? null,
      payment_method: body?.payment_method ?? null,
      payment_method_title: body?.payment_method_title ?? null,
      date_created_gmt: body?.date_created_gmt ?? null,
      date_modified_gmt: body?.date_modified_gmt ?? null,
      billing_country: billing.country ?? null,
      billing_phone_present: Boolean(billing.phone),
      akeed_markers: metaData
        .filter((entry) => isRecord(entry) && entry.key === AKEED_MARKER_KEY)
        .map((entry) => ({ id: entry.id ?? null, value: entry.value ?? null })),
      other_meta_entries: metaData.filter(
        (entry) => !isRecord(entry) || entry.key !== AKEED_MARKER_KEY,
      ).length,
      self_link: body?._links?.self?.[0]?.href ?? null,
      top_level_keys: isRecord(body) ? Object.keys(body).sort() : [],
    };
  },
  notes(body) {
    if (!Array.isArray(body)) return { not_a_list: true };
    return body.map((note) => ({
      id: note?.id ?? null,
      date_created_gmt: note?.date_created_gmt ?? null,
      customer_note: note?.customer_note ?? null,
      added_by_user: note?.added_by_user ?? null,
      note: maskText(note?.note ?? ''),
    }));
  },
  webhooks(body) {
    if (!Array.isArray(body)) return { not_a_list: true };
    return body.map((webhook) => ({
      id: webhook?.id ?? null,
      name: webhook?.name ?? null,
      status: webhook?.status ?? null,
      topic: webhook?.topic ?? null,
      hooks: webhook?.hooks ?? null,
      delivery_url: maskDeliveryUrl(webhook?.delivery_url),
      secret_returned: Object.hasOwn(webhook ?? {}, 'secret'),
      date_created_gmt: webhook?.date_created_gmt ?? null,
      date_modified_gmt: webhook?.date_modified_gmt ?? null,
    }));
  },
};

/** What a refusal says, without anything beyond its code and message. */
function sanitizeError(body) {
  if (!isRecord(body)) return { body: 'not a JSON object' };
  return {
    code: body.code ?? null,
    message: maskText(body.message ?? ''),
    data_status: isRecord(body.data) ? (body.data.status ?? null) : null,
  };
}

const path = paths[command]();
const record = {
  at: new Date().toISOString(),
  command,
  ...(argument ? { order_id: argument } : {}),
  request: `GET ${path.split('?')[0]}`,
};

try {
  const response = await fetch(`${storeUrl}${path}`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  record.http_status = response.status;
  record.headers = Object.fromEntries(
    KEPT_HEADERS.filter((name) => response.headers.has(name)).map((name) => [
      name,
      response.headers.get(name),
    ]),
  );
  record.body =
    body === undefined
      ? { not_json: true, length: text.length }
      : response.ok
        ? sanitize[command](body)
        : sanitizeError(body);
} catch (error) {
  record.failed = error instanceof Error ? error.name : 'unknown';
}

const line = JSON.stringify(record);
if (line.includes(key) || line.includes(secret))
  fail('Refusing to print: the answer contained the probe key or secret.');
mkdirSync(dirname(OUTPUT), { recursive: true });
appendFileSync(OUTPUT, `${line}\n`);
console.log(JSON.stringify(record, null, 2));
