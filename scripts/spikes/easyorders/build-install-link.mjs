#!/usr/bin/env node

// Builds an EasyOrders authorized-app install link for the US-06-01 spike and
// registers its throwaway URL token with the capture server.
//
//   node scripts/spikes/easyorders/build-install-link.mjs --label storeA
//   node scripts/spikes/easyorders/build-install-link.mjs --label storeA --no-status-webhook
//   node scripts/spikes/easyorders/build-install-link.mjs --label storeA --token-in query
//   node scripts/spikes/easyorders/build-install-link.mjs --label storeA --permissions orders:read
//   node scripts/spikes/easyorders/build-install-link.mjs --revoke storeA
//   node scripts/spikes/easyorders/build-install-link.mjs --list
//
// Each run for a label issues a new token and marks the label's previous one
// revoked under `<label>@<n>`, which is what a reconnect would do. Tokens live
// only in .tmp/spikes/easyorders/tokens.json (gitignored) and are spike-only.
//
// Env: EO_PUBLIC_BASE_URL (the public tunnel to the capture server).

import {
  fingerprint,
  loadTokens,
  newToken,
  parseArgs,
  requireEnv,
  saveTokens,
} from './lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const tokens = loadTokens();

if (flags.list) {
  for (const [label, entry] of Object.entries(tokens)) {
    console.log(
      `${label}\t${entry.revoked ? 'revoked' : 'active'}\tfp=${fingerprint(entry.token)}\t${entry.createdAt}`,
    );
  }
  process.exit(0);
}

if (typeof flags.revoke === 'string') {
  if (!tokens[flags.revoke]) {
    console.error(`No token labelled ${flags.revoke}`);
    process.exit(1);
  }
  tokens[flags.revoke].revoked = true;
  saveTokens(tokens);
  console.log(`Revoked ${flags.revoke}`);
  process.exit(0);
}

if (typeof flags.label !== 'string') {
  console.error('Usage: build-install-link.mjs --label <name> [options]');
  process.exit(1);
}

const base = requireEnv('EO_PUBLIC_BASE_URL').replace(/\/+$/, '');
const label = flags.label;
const permissions =
  typeof flags.permissions === 'string'
    ? flags.permissions
    : 'orders:read,orders:update';
const tokenInQuery = flags['token-in'] === 'query';

if (tokens[label]) {
  const generation = Object.keys(tokens).filter((key) =>
    key.startsWith(`${label}@`),
  ).length;
  tokens[`${label}@${generation + 1}`] = { ...tokens[label], revoked: true };
}
const token = newToken();
tokens[label] = {
  token,
  revoked: false,
  createdAt: new Date().toISOString(),
};
saveTokens(tokens);

const endpoint = (kind) =>
  tokenInQuery ? `${base}/${kind}?t=${token}` : `${base}/${kind}/${token}`;

const params = [
  ['app_name', 'Akeed (validation spike)'],
  ['app_description', 'COD order confirmation over WhatsApp'],
  ['app_icon', `${base}/icon.png`],
  ['permissions', permissions],
  ['callback_url', endpoint('cb')],
  ['orders_webhook', endpoint('orders')],
  ...(flags['no-status-webhook']
    ? []
    : [['order_status_webhook', endpoint('status')]]),
  ['redirect_url', endpoint('done')],
];

const link = `https://app.easy-orders.net/#/install-app?${params
  .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
  .join('&')}`;

console.log(
  `Label: ${label}  token fp=${fingerprint(token)}  in=${tokenInQuery ? 'query' : 'path'}`,
);
console.log(`Permissions: ${permissions}`);
console.log(
  `Status webhook: ${flags['no-status-webhook'] ? 'omitted' : 'included'}`,
);
console.log('\nOpen this link while signed in to the test store:\n');
console.log(link);
