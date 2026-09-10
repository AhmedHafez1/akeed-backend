#!/usr/bin/env node

// Proves the E04.5 merchant and staff billing surfaces ship complete Arabic and
// English copy: identical keys, non-empty values and the same ICU arguments.
// Marketing namespaces are outside the billing release and are not checked.

const fs = require('fs');
const path = require('path');

const FRONTEND_ROOT = path.resolve(
  process.env.E045_FRONTEND_ROOT ??
    path.join(__dirname, '..', '..', 'akeed-frontend'),
);
const MESSAGES_DIR = path.join(FRONTEND_ROOT, 'public', 'messages');

const billingNamespaces = [
  'billing',
  'creditErrors',
  'standaloneOnboarding',
  'adminCommon',
  'adminBilling',
  'adminBillingOps',
  'adminBillingObservability',
];

const failures = [];

function load(locale) {
  const file = path.join(MESSAGES_DIR, `${locale}.json`);
  if (!fs.existsSync(file)) {
    failures.push(`Missing ${path.relative(FRONTEND_ROOT, file)}`);
    return {};
  }
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function flatten(value, prefix, into) {
  for (const [key, child] of Object.entries(value)) {
    const name = `${prefix}.${key}`;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, name, into);
    } else {
      into.set(name, child);
    }
  }
  return into;
}

// Argument names only (`{count}`, `{count, plural, …}`); plural branch bodies
// legitimately differ between Arabic and English.
function argumentsOf(message) {
  const names = new Set();
  for (const match of String(message).matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)) {
    names.add(match[1]);
  }
  return [...names].sort().join(',');
}

const ar = load('ar');
const en = load('en');
let checked = 0;

for (const namespace of billingNamespaces) {
  if (!ar[namespace] || !en[namespace]) {
    failures.push(
      `Namespace ${namespace} must exist in both ar.json and en.json`,
    );
    continue;
  }
  const arMessages = flatten(ar[namespace], namespace, new Map());
  const enMessages = flatten(en[namespace], namespace, new Map());
  for (const key of new Set([...arMessages.keys(), ...enMessages.keys()])) {
    checked += 1;
    if (!arMessages.has(key)) {
      failures.push(`ar.json is missing ${key}`);
      continue;
    }
    if (!enMessages.has(key)) {
      failures.push(`en.json is missing ${key}`);
      continue;
    }
    const arValue = arMessages.get(key);
    const enValue = enMessages.get(key);
    if (typeof arValue !== 'string' || arValue.trim() === '') {
      failures.push(`ar.json has an empty or non-string ${key}`);
    }
    if (typeof enValue !== 'string' || enValue.trim() === '') {
      failures.push(`en.json has an empty or non-string ${key}`);
    }
    if (argumentsOf(arValue) !== argumentsOf(enValue)) {
      failures.push(
        `${key} uses different ICU arguments (ar: ${argumentsOf(arValue) || 'none'}; en: ${argumentsOf(enValue) || 'none'})`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`E04.5 billing locale parity failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `E04.5 billing locale parity: PASS (${checked} keys across ${billingNamespaces.length} namespaces)`,
);
