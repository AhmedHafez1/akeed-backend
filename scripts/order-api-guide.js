#!/usr/bin/env node

// Keeps the public server API guide and the tested contract the same thing
// (US-05-05). The examples, field limits, request limits and error codes of
// the guide are rendered from test/fixtures/order-api/guide-examples.json,
// the fixture that test/order-api-guide.contract-spec.ts runs over HTTP.
//
//   node scripts/order-api-guide.js           rewrites the generated sections
//   node scripts/order-api-guide.js --check   fails when the guide differs
//
// A generated section runs from its heading to the next heading of the same
// or a higher level. Everything else in the guide is written by hand, and the
// check still refuses a code block or an error code there that the fixture
// does not know.

const fs = require('fs');
const path = require('path');

const FRONTEND_ROOT = path.resolve(
  process.env.ORDER_API_GUIDE_FRONTEND_ROOT ??
    path.join(__dirname, '..', '..', 'akeed-frontend'),
);
const GUIDE = path.join(
  FRONTEND_ROOT,
  'content',
  'docs',
  'en',
  'server-api.md',
);
const FIXTURE = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'order-api',
  'guide-examples.json',
);

const STATUS_TEXT = {
  202: 'Accepted',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const ERROR_CODE =
  /\b(?:API_[A-Z]+(?:_[A-Z]+)+|INSUFFICIENT_CREDITS|CREDIT_[A-Z]+(?:_[A-Z]+)+)\b/g;

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function fence(language, text) {
  return ['```' + language, text, '```'].join('\n');
}

/** The body as the guide prints it; padding is described, not printed. */
function printedBody(step) {
  const body = { ...fixture.orders[step.request.order], ...step.request.with };
  const pad = step.request.padField;
  if (pad)
    body[pad.name] =
      `<${pad.characters.toLocaleString('en-US')} characters of text>`;
  return JSON.stringify(body, null, 2);
}

function curlRequest(step) {
  const lines = [
    `curl -i -X POST "$AKEED_API_URL${fixture.path}" \\`,
    '  -H "Authorization: Bearer $AKEED_API_KEY" \\',
  ];
  if (step.request.idempotencyKey !== null)
    lines.push(`  -H "Idempotency-Key: ${step.request.idempotencyKey}" \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '${printedBody(step)}'`);
  return fence('bash', lines.join('\n'));
}

function httpRequest(step) {
  const lines = [
    `POST ${fixture.path} HTTP/1.1`,
    'Host: <AKEED_API_HOST>',
    'Authorization: Bearer <API_KEY>',
  ];
  if (step.request.idempotencyKey !== null)
    lines.push(`Idempotency-Key: ${step.request.idempotencyKey}`);
  lines.push('Content-Type: application/json', '', printedBody(step));
  return fence('http', lines.join('\n'));
}

function httpResponse(step) {
  const { status, headers = {}, body } = step.response;
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}`,
    'Content-Type: application/json; charset=utf-8',
    'X-Correlation-Id: <CORRELATION_ID>',
  ];
  for (const [name, value] of Object.entries(headers))
    lines.push(`${name}: ${value}`);
  lines.push('', JSON.stringify(body, null, 2));
  return fence('http', lines.join('\n'));
}

function renderStep(step) {
  const show = step.show ?? 'all';
  if (show === 'none') return [];
  const parts = [];
  if (step.note) parts.push(step.note);
  if (show === 'all') {
    parts.push(curlRequest(step));
    if ((step.requestForms ?? []).includes('http'))
      parts.push('The same request as raw HTTP:', httpRequest(step));
  }
  parts.push(httpResponse(step));
  return parts;
}

function renderExamples() {
  const parts = [
    '## Examples',
    'Every example below is run by an automated test against a test instance of the API, so the statuses and bodies are exactly what you get. Values in angle brackets, such as `<ORDER_ID>`, are placeholders. `$AKEED_API_URL` and `$AKEED_API_KEY` are your endpoint address and your key; all order data is made up.',
  ];
  for (const example of fixture.examples) {
    parts.push(`### ${example.title}`, example.intro);
    for (const step of example.steps) parts.push(...renderStep(step));
  }
  return parts.join('\n\n');
}

function fieldRule(field) {
  const length =
    field.minLength && field.maxLength
      ? ` ${field.minLength} to ${field.maxLength} characters.`
      : field.maxLength
        ? ` Up to ${field.maxLength.toLocaleString('en-US')} characters.`
        : '';
  return `${field.rule}${length}`;
}

function renderFieldReference() {
  const rows = fixture.fields.map(
    (field) =>
      `| \`${field.name}\` | ${field.required ? 'Yes' : 'No'} | ${fieldRule(field)} |`,
  );
  return [
    '### Field reference',
    [
      '| Field | Required | What to send |',
      '| --- | --- | --- |',
      ...rows,
    ].join('\n'),
    `Supported currencies: ${fixture.currencies.join(', ')}.`,
  ].join('\n\n');
}

function renderLimits() {
  const { limits } = fixture;
  const rows = [
    `| Requests | ${limits.perStorePerMinute} per minute for each store. All keys of a store share the limit, so a second key does not add requests. |`,
    `| Request size | ${limits.maxBodyBytes / 1024} KB for each request body. |`,
    '| Orders per request | One. There is no batch endpoint. |',
    `| \`Idempotency-Key\` | ${limits.idempotencyKeyMinLength} to ${limits.idempotencyKeyMaxLength} characters: letters, numbers, dots, underscores, colons and hyphens. |`,
  ];
  return [
    '## Limits',
    ['| Limit | Value |', '| --- | --- |', ...rows].join('\n'),
    'A request over a limit is refused before Akeed looks at the order, so it never creates an order or uses a credit. These are the standard limits. If your store needs more, contact support before you go live.',
  ].join('\n\n');
}

function renderErrorCodes() {
  const rows = fixture.errors.map(
    (error) =>
      `| \`${error.code}\` | ${error.status} | ${error.meaning} | ${error.action} |`,
  );
  return [
    '## Error Codes',
    'Every error has the same shape. Read `code`, not the message text: codes never change, messages may be reworded.',
    fence(
      'json',
      JSON.stringify(
        {
          code: 'API_VALIDATION_FAILED',
          message: 'Order validation failed.',
          correlationId: '<CORRELATION_ID>',
          fieldErrors: { customerPhone: 'Invalid phone number format.' },
        },
        null,
        2,
      ),
    ),
    '`fieldErrors` appears only with `API_VALIDATION_FAILED`. `correlationId` is also sent in the `X-Correlation-Id` response header, on successful requests too.',
    [
      '| Code | Status | What it means | What to do |',
      '| --- | --- | --- | --- |',
      ...rows,
    ].join('\n'),
    'If you receive a `409` with a code that is not in this table, treat it the same way as the credit codes: the store cannot send right now, and nothing was stored.',
  ].join('\n\n');
}

const GENERATED = [
  { heading: '### Field reference', render: renderFieldReference },
  { heading: '## Limits', render: renderLimits },
  { heading: '## Examples', render: renderExamples },
  { heading: '## Error Codes', render: renderErrorCodes },
];

/** The line range of a section: its heading up to the next one of its level. */
function sectionRange(lines, heading) {
  const start = lines.indexOf(heading);
  if (start === -1) return null;
  const level = heading.match(/^#+/)[0].length;
  const next = new RegExp(`^#{1,${level}} `);
  let end = start + 1;
  let fenced = false;
  for (; end < lines.length; end++) {
    if (lines[end].startsWith('```')) fenced = !fenced;
    if (!fenced && next.test(lines[end])) break;
  }
  return { start, end };
}

function regenerate(guide) {
  let lines = guide.split('\n');
  for (const { heading, render } of GENERATED) {
    const range = sectionRange(lines, heading);
    if (!range)
      throw new Error(`The guide has no "${heading}" section to generate.`);
    lines = [
      ...lines.slice(0, range.start),
      ...render().split('\n'),
      '',
      ...lines.slice(range.end),
    ];
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

/** Every code block the fixture can vouch for. */
function testedBlocks() {
  const blocks = new Set();
  for (const example of fixture.examples)
    for (const step of example.steps) {
      blocks.add(curlRequest(step));
      blocks.add(httpRequest(step));
      blocks.add(httpResponse(step));
    }
  return blocks;
}

/** Problems in the hand-written part that regenerating cannot fix. */
function handWrittenProblems(guide) {
  const problems = [];
  const tested = testedBlocks();
  let lines = guide.split('\n');
  for (const { heading } of GENERATED) {
    const range = sectionRange(lines, heading);
    if (range)
      lines = [...lines.slice(0, range.start), ...lines.slice(range.end)];
  }
  const handWritten = lines.join('\n');

  for (const [block, language] of handWritten.matchAll(
    /^```(\w*)\n[\s\S]*?\n```$/gm,
  )) {
    if (language === 'text' || tested.has(block)) continue;
    problems.push(
      `A ${language || 'plain'} code block outside the generated sections is not one of the tested examples:\n${block}`,
    );
  }

  const known = new Set(fixture.errors.map((error) => error.code));
  for (const [code] of handWritten.matchAll(ERROR_CODE))
    if (!known.has(code))
      problems.push(
        `The guide mentions ${code}, which the fixture does not document.`,
      );
  return problems;
}

function main() {
  const check = process.argv.includes('--check');
  if (!fs.existsSync(GUIDE)) {
    console.error(`Missing ${GUIDE}`);
    process.exit(1);
  }
  const current = fs.readFileSync(GUIDE, 'utf8').replace(/\r\n/g, '\n');
  const expected = regenerate(current);
  const problems = handWrittenProblems(expected);

  if (!check) {
    fs.writeFileSync(GUIDE, expected.replace(/\n/g, '\r\n'));
    console.log(
      `Server API guide: wrote ${path.relative(FRONTEND_ROOT, GUIDE)}`,
    );
  } else if (current !== expected) {
    const was = current.split('\n');
    const now = expected.split('\n');
    const differs = now.findIndex((text, index) => text !== was[index]);
    const line = differs === -1 ? now.length : differs;
    problems.unshift(
      `The generated sections differ from the fixture, first at line ${line + 1}. Run "npm run docs:order-api-guide".\n  guide:   ${was[line] ?? '(end of file)'}\n  fixture: ${now[line] ?? '(end of file)'}`,
    );
  }

  if (problems.length > 0) {
    console.error(`Server API guide check failed (${problems.length}):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  if (check)
    console.log(
      `Server API guide: PASS (${fixture.examples.length} examples, ${fixture.errors.length} error codes, ${fixture.fields.length} fields)`,
    );
}

main();
