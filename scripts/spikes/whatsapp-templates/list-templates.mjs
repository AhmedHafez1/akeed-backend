#!/usr/bin/env node

// Lists every message template in the WhatsApp Business Account of the
// environment it runs in, for US-08-01. READ-ONLY: it sends GET requests to one
// Graph API edge and never creates, edits or deletes anything.
//
//   node --env-file=.env scripts/spikes/whatsapp-templates/list-templates.mjs --env dev
//   node --env-file=.env scripts/spikes/whatsapp-templates/list-templates.mjs --env prod
//   node scripts/spikes/whatsapp-templates/list-templates.mjs --self-test
//
// Env: WA_BUSINESS_ACCOUNT_ID and WA_ACCESS_TOKEN. Nothing else is read.
// The token needs the `whatsapp_business_management` permission.
//
// Output is printed and written to .tmp/spikes/whatsapp-templates/<env>/
// (gitignored). The access token is never printed or written.
//
// `--self-test` uses no network and no credentials: it runs the same code
// against a stub with a dummy token and fails if that token shows up anywhere.

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  BACKEND_ROOT,
  GRAPH_API_VERSION,
  createScrubber,
  ensureDir,
  evidenceDir,
  graphGet,
  kitFingerprint,
  parseArgs,
  scrubDeep,
} from './lib.mjs';

const REQUESTED_FIELDS = [
  'id',
  'name',
  'language',
  'status',
  'category',
  'sub_category',
  'previous_category',
  'correct_category',
  'quality_score',
  'rejected_reason',
  'parameter_format',
  'components',
  'message_send_ttl_seconds',
  'cta_url_link_tracking_opted_out',
  'library_template_name',
];
// Without these there is nothing to reconcile, so they are never dropped.
const CORE_FIELDS = new Set([
  'id',
  'name',
  'language',
  'status',
  'category',
  'components',
]);
const SUMMARY_FIELDS =
  'total_count,message_template_count,message_template_limit';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
const RUN_ENVS = ['dev', 'prod'];

const USAGE = [
  'Usage:',
  '  node --env-file=.env scripts/spikes/whatsapp-templates/list-templates.mjs --env dev|prod',
  '  node scripts/spikes/whatsapp-templates/list-templates.mjs --self-test',
].join('\n');

// Graph answers an unknown field with error 100 and names it. The run goes on
// without that field, and which fields were dropped is itself a finding.
function findRejectedField(message, fields) {
  const match = /nonexisting field \(([^)]+)\)/i.exec(message ?? '');
  const field = match?.[1]?.trim();
  return field && fields.includes(field) && !CORE_FIELDS.has(field)
    ? field
    : null;
}

async function listAllTemplates({ wabaId, token, fetchImpl }) {
  let fields = [...REQUESTED_FIELDS];
  let withSummary = true;
  const droppedFields = [];
  const templates = [];
  let summary = null;
  let after;
  let pages = 0;
  let truncated = false;

  for (;;) {
    const result = await graphGet({
      apiPath: `${wabaId}/message_templates`,
      query: {
        fields: fields.join(','),
        limit: PAGE_LIMIT,
        summary: withSummary ? SUMMARY_FIELDS : undefined,
        after,
      },
      token,
      fetchImpl,
    });

    if (!result.ok) {
      const rejected =
        result.error.code === 100
          ? findRejectedField(result.error.message, fields)
          : null;
      if (rejected) {
        fields = fields.filter((field) => field !== rejected);
        droppedFields.push(rejected);
        continue;
      }
      if (
        result.error.code === 100 &&
        withSummary &&
        /summary/i.test(result.error.message)
      ) {
        withSummary = false;
        continue;
      }
      return { ok: false, status: result.status, error: result.error };
    }

    pages += 1;
    if (Array.isArray(result.body.data)) templates.push(...result.body.data);
    summary ??= result.body.summary ?? null;

    // `paging.next` is read only as a yes or no. It is never followed, stored
    // or printed, because Graph can embed the access token in it.
    const cursor = result.body.paging?.cursors?.after;
    const hasNext = Boolean(result.body.paging?.next);
    if (!hasNext || !cursor || cursor === after) break;
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
    after = cursor;
  }

  templates.sort(
    (left, right) =>
      String(left.name).localeCompare(String(right.name)) ||
      String(left.language).localeCompare(String(right.language)),
  );
  return {
    ok: true,
    templates,
    summary,
    pages,
    truncated,
    requestedFields: fields,
    droppedFields,
    summaryRequested: withSummary,
  };
}

function qualityOf(template) {
  const score = template.quality_score;
  if (score && typeof score === 'object') return score.score ?? 'n/a';
  return typeof score === 'string' ? score : 'n/a';
}

function printTemplate(template, say) {
  say(`== ${template.name} [${template.language}]`);
  say(
    [
      `   status=${template.status ?? 'n/a'}`,
      `category=${template.category ?? 'n/a'}`,
      `quality=${qualityOf(template)}`,
      `parameter_format=${template.parameter_format ?? 'n/a'}`,
      `id=${template.id ?? 'n/a'}`,
    ].join('  '),
  );
  const extras = [
    'sub_category',
    'previous_category',
    'correct_category',
    'rejected_reason',
    'message_send_ttl_seconds',
    'library_template_name',
  ]
    .filter(
      (field) => template[field] !== undefined && template[field] !== null,
    )
    .map((field) => `${field}=${JSON.stringify(template[field])}`);
  if (extras.length) say(`   ${extras.join('  ')}`);
  say('   components:');
  const components = JSON.stringify(template.components ?? [], null, 2);
  for (const line of components.split('\n')) say(`     ${line}`);
  say('');
}

function hintFor(status, code) {
  if (status === null) {
    return 'No answer from graph.facebook.com. Check the network and run again.';
  }
  if (code === 190 || code === 0) {
    return 'The access token is invalid or expired.';
  }
  if (code === 10 || code === 3 || (code >= 200 && code <= 299)) {
    return 'The token lacks the whatsapp_business_management permission, or its system user has no access to this WhatsApp Business Account.';
  }
  if (code === 100) {
    return 'Check that WA_BUSINESS_ACCOUNT_ID is the WhatsApp Business Account ID, not the phone number ID, and that the token can see it.';
  }
  if (code === 4 || code === 80007 || code === 80008) {
    return 'Meta is rate limiting. Wait before running again.';
  }
  return null;
}

function writeSafe(file, value, scrub, token) {
  const text = scrub(`${JSON.stringify(scrubDeep(value, scrub), null, 2)}\n`);
  if (text.includes(token)) {
    throw new Error('Refusing to write: the output would contain the token.');
  }
  writeFileSync(file, text);
}

function filesContaining(dir, token) {
  const needles = [token, encodeURIComponent(token)];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const text = readFileSync(path.join(dir, name), 'utf8');
      return needles.some((needle) => text.includes(needle));
    });
}

async function run({ label, wabaId, token, fetchImpl, out }) {
  const scrub = createScrubber([token]);
  const say = (text = '') => out.log(scrub(text));
  const warn = (text = '') => out.error(scrub(text));
  const dir = evidenceDir(label);
  const meta = {
    kit: 'US-08-01 whatsapp-templates',
    kitFingerprint: kitFingerprint(),
    env: label,
    ranAt: new Date().toISOString(),
    graphApiVersion: GRAPH_API_VERSION,
    request: `GET /${GRAPH_API_VERSION}/<WA_BUSINESS_ACCOUNT_ID>/message_templates`,
    wabaIdTail: wabaId.slice(-4),
    pageLimit: PAGE_LIMIT,
  };

  say(
    `WhatsApp template list (read-only) | env=${label} | Graph ${GRAPH_API_VERSION} | account ending ${meta.wabaIdTail}`,
  );
  say('');

  const result = await listAllTemplates({ wabaId, token, fetchImpl });
  ensureDir(dir);

  if (!result.ok) {
    warn('The request to Meta failed. Nothing was changed at Meta.');
    warn(`  HTTP status: ${result.status ?? 'none'}`);
    warn(`  Meta error code: ${result.error.code ?? 'none'}`);
    warn(`  Meta message: ${result.error.message}`);
    const hint = hintFor(result.status, result.error.code);
    if (hint) warn(`  Hint: ${hint}`);
    writeSafe(
      path.join(dir, 'last-error.json'),
      {
        meta,
        error: {
          status: result.status,
          code: result.error.code,
          message: result.error.message,
        },
      },
      scrub,
      token,
    );
    return 2;
  }

  for (const template of result.templates) printTemplate(template, say);

  const file = path.join(dir, 'templates.json');
  writeSafe(
    file,
    {
      meta: {
        ...meta,
        requestedFields: result.requestedFields,
        droppedFields: result.droppedFields,
        summaryRequested: result.summaryRequested,
        pages: result.pages,
        truncated: result.truncated,
        templateCount: result.templates.length,
        summary: result.summary,
      },
      templates: result.templates,
    },
    scrub,
    token,
  );

  say(`${result.templates.length} template(s) in ${result.pages} page(s).`);
  if (result.droppedFields.length) {
    say(
      `Graph ${GRAPH_API_VERSION} does not know these fields, so the run went on without them: ${result.droppedFields.join(', ')}`,
    );
  }
  if (result.truncated) {
    warn(
      `Stopped after ${MAX_PAGES} pages with more to read. The list is incomplete.`,
    );
  }
  say(`Wrote ${path.relative(BACKEND_ROOT, file)}`);

  const leaks = filesContaining(dir, token);
  if (leaks.length) {
    warn(`The access token was found in: ${leaks.join(', ')}. Delete them.`);
    return 3;
  }
  say('Checked every file in that folder: the access token is not in them.');
  return result.truncated ? 4 : 0;
}

// ---------------------------------------------------------------------------
// Self-test. No network, no credentials.
// ---------------------------------------------------------------------------

// Characters that URL-encode differently, so both forms are exercised.
const SELF_TEST_TOKEN = [
  'EAASELFTEST',
  'dummy/Token+value=',
  '0123456789',
].join('|');
const SELF_TEST_WABA_ID = '100000000000001';

function makeStub(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      hasBody: init.body !== undefined,
      authorization: init.headers?.Authorization,
    });
    const next = responses[calls.length - 1];
    if (!next) throw new Error('unexpected extra request');
    if (next.throws) throw next.throws;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body),
    };
  };
  return { calls, fetchImpl };
}

function syntheticTemplate(id, name, language, bodyText) {
  return {
    id,
    name,
    language,
    status: 'APPROVED',
    category: 'UTILITY',
    quality_score: { score: 'UNKNOWN', date: 1 },
    parameter_format: 'NAMED',
    components: [
      { type: 'BODY', text: bodyText },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirm' },
          { type: 'QUICK_REPLY', text: 'Cancel' },
        ],
      },
    ],
  };
}

async function selfTest() {
  const token = SELF_TEST_TOKEN;
  const encoded = encodeURIComponent(token);
  const label = 'self-test';
  const dir = evidenceDir(label);
  rmSync(dir, { recursive: true, force: true });

  const captured = [];
  const out = {
    log: (text) => {
      captured.push(String(text));
      console.log(text);
    },
    error: (text) => {
      captured.push(String(text));
      console.error(text);
    },
  };
  const checks = [];
  const check = (name, passed) =>
    checks.push({ name, passed: Boolean(passed) });
  const prefix = `https://graph.facebook.com/${GRAPH_API_VERSION}/${SELF_TEST_WABA_ID}/message_templates?`;

  // A: an unknown field, then two pages. Page one carries a `paging.next` with
  // the token in it and a template whose text echoes the token.
  const listing = makeStub([
    {
      status: 400,
      body: {
        error: {
          message:
            '(#100) Tried accessing nonexisting field (library_template_name) on node type (WhatsAppMessageTemplate)',
          type: 'OAuthException',
          code: 100,
          fbtrace_id: 'SELFTEST',
        },
      },
    },
    {
      status: 200,
      body: {
        data: [
          syntheticTemplate('1', 'sample_b', 'en', `Echo ${token} {{order}}`),
          syntheticTemplate('2', 'sample_a', 'ar', 'Body {{order}}'),
        ],
        paging: {
          cursors: { before: 'B1', after: 'A1' },
          next: `${prefix}access_token=${encoded}&after=A1`,
        },
        summary: {
          total_count: 3,
          message_template_count: 3,
          message_template_limit: 250,
        },
      },
    },
    {
      status: 200,
      body: {
        data: [syntheticTemplate('3', 'sample_a', 'en', 'Body {{order}}')],
        paging: { cursors: { before: 'B2', after: 'A2' } },
      },
    },
  ]);
  const listingCode = await run({
    label,
    wabaId: SELF_TEST_WABA_ID,
    token,
    fetchImpl: listing.fetchImpl,
    out,
  });
  const written = existsSync(path.join(dir, 'templates.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'templates.json'), 'utf8'))
    : null;
  check('listing exits 0', listingCode === 0);
  check('listing made three requests', listing.calls.length === 3);
  check(
    'second request drops the rejected field',
    !listing.calls[1]?.url.includes('library_template_name'),
  );
  check('page two uses the cursor', listing.calls[2]?.url.includes('after=A1'));
  check('three templates written', written?.meta?.templateCount === 3);
  check(
    'dropped field recorded',
    written?.meta?.droppedFields?.join() === 'library_template_name',
  );
  check('two pages recorded', written?.meta?.pages === 2);
  check('paging is not stored', written !== null && !('paging' in written));

  // B: Meta rejects the token and echoes it back in the message.
  const rejected = makeStub([
    {
      status: 401,
      body: {
        error: {
          message: `Error validating access token ${token}. Sent as Bearer ${token}`,
          type: 'OAuthException',
          code: 190,
          fbtrace_id: 'SELFTEST',
        },
      },
    },
  ]);
  const rejectedCode = await run({
    label,
    wabaId: SELF_TEST_WABA_ID,
    token,
    fetchImpl: rejected.fetchImpl,
    out,
  });
  check('rejected token exits 2', rejectedCode === 2);
  check(
    'error report names status and code',
    captured.some((line) => line.includes('HTTP status: 401')) &&
      captured.some((line) => line.includes('Meta error code: 190')),
  );
  check('error file written', existsSync(path.join(dir, 'last-error.json')));

  // C: the request throws, with the token in the thrown message.
  const broken = makeStub([
    { throws: new TypeError(`fetch failed for Bearer ${token}`) },
  ]);
  const brokenCode = await run({
    label,
    wabaId: SELF_TEST_WABA_ID,
    token,
    fetchImpl: broken.fetchImpl,
    out,
  });
  check('failed request exits 2', brokenCode === 2);

  const calls = [...listing.calls, ...rejected.calls, ...broken.calls];
  check(
    'every request is a GET without a body',
    calls.every((call) => call.method === 'GET' && !call.hasBody),
  );
  check(
    'every request goes to the pinned edge',
    calls.every((call) => call.url.startsWith(prefix)),
  );
  check(
    'no request URL carries the token',
    calls.every(
      (call) => !call.url.includes(token) && !call.url.includes(encoded),
    ),
  );
  check(
    'the token travels in the Authorization header',
    calls.every((call) => call.authorization === `Bearer ${token}`),
  );
  check(
    'the token is not in anything printed',
    captured.every((line) => !line.includes(token) && !line.includes(encoded)),
  );
  check(
    'the token is not in any file written',
    filesContaining(dir, token).length === 0,
  );

  console.log('');
  for (const { name, passed } of checks) {
    console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}`);
  }
  const failed = checks.filter((entry) => !entry.passed).length;
  console.log(
    failed
      ? `SELF-TEST FAIL: ${failed} of ${checks.length} checks`
      : `SELF-TEST PASS: ${checks.length} checks`,
  );
  return failed ? 1 : 0;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags['self-test']) return selfTest();

  if (!RUN_ENVS.includes(flags.env)) {
    console.error(USAGE);
    return 1;
  }
  const wabaId = (process.env.WA_BUSINESS_ACCOUNT_ID ?? '').trim();
  const token = (process.env.WA_ACCESS_TOKEN ?? '').trim();
  if (!wabaId) {
    console.error('Missing environment variable WA_BUSINESS_ACCOUNT_ID');
    return 1;
  }
  if (!/^\d{5,25}$/.test(wabaId)) {
    console.error(
      'WA_BUSINESS_ACCOUNT_ID must be the numeric WhatsApp Business Account ID.',
    );
    return 1;
  }
  if (!token) {
    console.error('Missing environment variable WA_ACCESS_TOKEN');
    return 1;
  }
  return run({ label: flags.env, wabaId, token, out: console });
}

process.exitCode = await main();
