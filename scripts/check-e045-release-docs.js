#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EPIC_DIR = path.join(
  ROOT,
  'docs',
  'Epics',
  '04.5-standalone-paymob-usage-billing',
);

const stories = [
  [
    '01',
    'US-04.5-01-credit-and-payment-domain-foundation.md',
    'US-04.5-01-CREDIT-AND-PAYMENT-FOUNDATION-EVIDENCE.md',
  ],
  [
    '02',
    'US-04.5-02-approval-and-one-time-grant.md',
    'US-04.5-02-APPROVAL-AND-ONE-TIME-GRANT-EVIDENCE.md',
  ],
  [
    '03',
    'US-04.5-03-provider-neutral-usage-accounting.md',
    'US-04.5-03-PROVIDER-NEUTRAL-USAGE-ACCOUNTING-EVIDENCE.md',
  ],
  [
    '04',
    'US-04.5-04-paymob-checkout-and-callbacks.md',
    'US-04.5-04-PAYMOB-CHECKOUT-AND-CALLBACKS-EVIDENCE.md',
  ],
  [
    '05',
    'US-04.5-05-merchant-billing-experience.md',
    'US-04.5-05-MERCHANT-BILLING-EXPERIENCE-EVIDENCE.md',
  ],
  [
    '06',
    'US-04.5-06-staff-billing-operations.md',
    'US-04.5-06-STAFF-BILLING-OPERATIONS-EVIDENCE.md',
  ],
  [
    '07',
    'US-04.5-07-observability-and-finance-reconciliation.md',
    'US-04.5-07-BILLING-OBSERVABILITY-AND-FINANCE-RECONCILIATION-EVIDENCE.md',
  ],
  [
    '08',
    'US-04.5-08-sandbox-and-production-release-gate.md',
    'US-04.5-08-SANDBOX-AND-PRODUCTION-RELEASE-GATE-EVIDENCE.md',
  ],
  [
    '09',
    'US-04.5-09-standalone-signup-auto-activation.md',
    'US-04.5-09-STANDALONE-AUTO-ACTIVATION-EVIDENCE.md',
  ],
];

const requiredEnvironmentKeys = [
  'STANDALONE_CREDIT_BILLING_ENABLED',
  'STANDALONE_BILLING_OPERATIONS_ENABLED',
  'STANDALONE_BILLING_OPERATOR_IDS',
  'STANDALONE_BILLING_SCHEDULED_INQUIRY_ENABLED',
  'STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY',
  'PAYMOB_MODE',
  'PAYMOB_BASE_URL',
  'PAYMOB_CALLBACK_URL',
  'PAYMOB_RETURN_URL',
  'PAYMOB_SECRET_KEY',
  'PAYMOB_HMAC_SECRET',
  'PAYMOB_PUBLIC_KEY',
  'PAYMOB_CARD_INTEGRATION_ID',
  'PAYMOB_WALLET_INTEGRATION_ID',
  'PAYMOB_CHECKOUT_EXPIRATION_SECONDS',
];

const failures = [];

function read(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    failures.push(`Missing ${relativePath}`);
    return '';
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function requireText(contents, expected, label) {
  if (!contents.includes(expected))
    failures.push(`${label} is missing: ${expected}`);
}

const epic = read('docs/Epics/04.5-standalone-paymob-usage-billing/README.md');
const scannedEvidence = [];
for (const [number, storyFile, evidenceFile] of stories) {
  const storyPath = path.join(
    'docs',
    'Epics',
    '04.5-standalone-paymob-usage-billing',
    storyFile,
  );
  const story = read(storyPath);
  const evidence = read(path.join('docs', evidenceFile));
  scannedEvidence.push([evidenceFile, evidence]);
  requireText(epic, `(${storyFile})`, 'E04.5 README');
  requireText(evidence, `US-04.5-${number}`, evidenceFile);
  if (number !== '08') requireText(story, '- **Status:** Done', storyFile);
}

const releaseStory = read(
  'docs/Epics/04.5-standalone-paymob-usage-billing/US-04.5-08-sandbox-and-production-release-gate.md',
);
const releaseEvidence = read(
  'docs/US-04.5-08-SANDBOX-AND-PRODUCTION-RELEASE-GATE-EVIDENCE.md',
);
const releaseStatus = releaseStory.match(/^- \*\*Status:\*\* (.+)$/m)?.[1];
if (!['Blocked', 'Done'].includes(releaseStatus)) {
  failures.push('US-04.5-08 status must be Blocked or Done');
}
requireText(epic, `| ${releaseStatus} |`, 'E04.5 README release status');
requireText(
  releaseEvidence,
  `Overall release decision: ${releaseStatus === 'Done' ? 'PASS' : 'BLOCKED'}`,
  'US-04.5-08 evidence',
);
for (const status of ['PASS', 'PENDING', 'BLOCKED', 'RESIDUAL GATE']) {
  requireText(releaseEvidence, status, 'US-04.5-08 evidence status vocabulary');
}
for (const heading of [
  '## Release candidate',
  '## Automated acceptance matrix',
  '## Sandbox evidence matrix',
  '## Controlled-production evidence matrix',
  '## Monitoring and runbook drills',
  '## Go/no-go approval',
  '## Rollback record',
]) {
  requireText(releaseEvidence, heading, 'US-04.5-08 evidence');
}

const environmentExample = read('.env.example');
for (const key of requiredEnvironmentKeys) {
  if (!new RegExp(`^${key}=`, 'm').test(environmentExample)) {
    failures.push(`.env.example is missing ${key}`);
  }
}

const packageJson = JSON.parse(read('package.json'));
if (!packageJson.scripts?.['test:gate:e045']) {
  failures.push('package.json is missing test:gate:e045');
}
if (!packageJson.scripts?.['test:contract:e045']) {
  failures.push('package.json is missing test:contract:e045');
}
for (const gateFile of [
  'scripts/test-e045-release-gate.ps1',
  'scripts/test-e045-contracts.ps1',
  'scripts/test-e045-inherited-gates.ps1',
  'scripts/check-e045-locale-parity.js',
]) {
  if (!fs.existsSync(path.join(ROOT, gateFile))) {
    failures.push(`Missing release-gate file ${gateFile}`);
  }
}

for (const expected of [
  'does not delete purchases',
  'In-flight callbacks remain accepted',
  'STANDALONE_CREDIT_BILLING_ENABLED=false',
  'STANDALONE_BILLING_RECONCILIATION_REPORT_ONLY=true',
]) {
  const combined = `${releaseStory}\n${releaseEvidence}`;
  requireText(
    combined,
    expected,
    'release rollback and dark-launch documentation',
  );
}

const secretPatterns = [
  /clientSecret\s*=/i,
  /Bearer\s+eyJ[A-Za-z0-9_-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:PAYMOB_SECRET_KEY|PAYMOB_HMAC_SECRET|META_APP_SECRET)\s*=\s*[^<\s`]+/i,
  /(?:PAN|CVV)\s*[:=]\s*\d+/i,
];
for (const [evidenceFile, evidence] of scannedEvidence) {
  for (const pattern of secretPatterns) {
    if (pattern.test(evidence)) {
      failures.push(
        `${evidenceFile} matches forbidden secret pattern ${pattern}`,
      );
    }
  }
  // Database URLs in evidence must withhold their password behind a placeholder.
  for (const match of evidence.matchAll(
    /postgres(?:ql)?:\/\/[^:\s/@]+:([^@\s]+)@/g,
  )) {
    if (!/^(?:<[^<>]+>|…|\*+)$/.test(match[1])) {
      failures.push(
        `${evidenceFile} contains a database URL with a literal password`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`E04.5 release documentation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('E04.5 release documentation: PASS');
