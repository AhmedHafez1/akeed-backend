// Offline authoring only. Never loads .env, connects to a database, or calls a provider.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
const {
  planChangeDraft,
} = require('../src/shared/messaging/change-request-preparation.policy');
const {
  toRegistryTemplate,
} = require('../src/infrastructure/database/repositories/whatsapp-templates.repository');
const {
  describeMetaComponents,
} = require('../src/infrastructure/spokes/meta/meta-template-text');
const snapshotPath = process.argv[2];
const {
  deriveDraftVariables,
  toTemplateSubmission,
} = require('../src/shared/messaging/template-draft.validation');
const providerBody = (content) =>
  toTemplateSubmission(content)
    .body.map((segment) =>
      'text' in segment ? segment.text : `{{${segment.parameter}}}`,
    )
    .join('');
const outputPath = process.argv[3];
if (!snapshotPath || !outputPath)
  throw new Error(
    'Usage: node scripts/prepare-change-request-production.cjs <snapshot.json> <output-directory>',
  );
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const migrationTag = '0093_change_request_messaging';
const journal = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../drizzle/meta/_journal.json'),
    'utf8',
  ),
).entries;
const entry = journal.find((e) => e.tag === migrationTag);
const previous = journal[journal.indexOf(entry) - 1];
const migration = fs
  .readFileSync(
    path.join(__dirname, '../drizzle', migrationTag + '.sql'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');
const hash = crypto.createHash('sha256').update(migration).digest('hex');
const previousSql = fs
  .readFileSync(
    path.join(__dirname, '../drizzle', previous.tag + '.sql'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');
const previousHash = crypto
  .createHash('sha256')
  .update(previousSql)
  .digest('hex');
const latest = snapshot.journal.at(-1);
if (Number(latest.created_at) !== previous.when || latest.hash !== previousHash)
  throw new Error('Snapshot must end at the verified 0092 journal entry');
const camel = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ]),
  );
const plans = snapshot.templates
  .filter((t) => t.header_format === 'none' && !t.retired_at)
  .map((t) => {
    const draft = snapshot.drafts.find((d) => d.key === t.key);
    const plan = planChangeDraft(
      toRegistryTemplate(camel(t)),
      describeMetaComponents(t.components_snapshot),
      t.updated_at,
      draft?.samples,
    );
    if (!plan || plan.issues.some((i) => i.severity === 'error'))
      throw new Error(
        'Unreviewable source ' + t.key + ': ' + JSON.stringify(plan?.issues),
      );
    return plan;
  });
const quote = (value) =>
  "E'" +
  String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "''")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n') +
  "'";
const json = (value) => quote(JSON.stringify(value)) + '::jsonb';
const before = snapshot.templates;
// PostgreSQL jsonb prints object keys in UTF-8 length/binary order.
const jsonbText = (value) =>
  Array.isArray(value)
    ? '[' + value.map(jsonbText).join(', ') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort(
            (a, b) =>
              Buffer.byteLength(a) - Buffer.byteLength(b) ||
              Buffer.compare(Buffer.from(a), Buffer.from(b)),
          )
          .map((key) => JSON.stringify(key) + ': ' + jsonbText(value[key]))
          .join(', ') +
        '}'
      : JSON.stringify(value);
const sourceFingerprint = crypto
  .createHash('md5')
  .update(jsonbText(before))
  .digest('hex');
const sql = [
  '-- Execute as one transaction through the authorized database maintenance tool.',
  'select pg_advisory_xact_lock(29160427);',
  `do $guard$ begin if (select max(created_at) from drizzle.__drizzle_migrations) <> ${previous.when} or not exists(select 1 from drizzle.__drizzle_migrations where created_at=${previous.when} and hash=${quote(previousHash)}) then raise exception 'CHANGE_PREPARATION_JOURNAL_CHANGED'; end if; end $guard$;`,
  `do $guard$ begin if (select md5(jsonb_agg(to_jsonb(t)-'id' order by key)::text) from whatsapp_templates t) is distinct from ${quote(sourceFingerprint)} then raise exception 'CHANGE_PREPARATION_SOURCE_CHANGED'; end if; end $guard$;`,
  'create temporary table change_preparation_existing_drafts on commit drop as select id from whatsapp_template_drafts;',
  migration,
  ...plans.map((plan) => {
    const c = plan.content;
    return `update whatsapp_template_drafts set parameter_format=${quote(c.parameterFormat)}, category=${quote(c.category)}, body=${quote(c.body)}, confirm_label=${quote(c.confirmLabel)}, cancel_label=${quote(c.cancelLabel)}, change_label=${quote(c.changeLabel)}, samples=${json(c.samples)} where key=${quote(plan.key)} and change_request_of_key=${quote(plan.parentKey)} and state='draft' and template_id is null and created_by='00000000-0000-0000-0000-000000000000' and updated_by=created_by and updated_at=created_at and id not in(select id from change_preparation_existing_drafts);`;
  }),
  `do $guard$ begin if (select count(*) from whatsapp_template_drafts where change_request_of_key is not null) <> ${plans.length} then raise exception 'CHANGE_PREPARATION_COUNT_MISMATCH'; end if; end $guard$;`,
  ...plans.map(
    (plan) =>
      `do $guard$ begin if not exists(select 1 from whatsapp_template_drafts where key=${quote(plan.key)} and change_request_of_key=${quote(plan.parentKey)} and state='draft' and body=${quote(plan.content.body)} and confirm_label=${quote(plan.content.confirmLabel)} and cancel_label=${quote(plan.content.cancelLabel)} and change_label=${quote(plan.content.changeLabel)} and parameter_format=${quote(plan.content.parameterFormat)} and meta_language_code=${quote(plan.content.languageCode)}) then raise exception 'CHANGE_PREPARATION_DRAFT_MISMATCH'; end if; end $guard$;`,
  ),
  `insert into drizzle.__drizzle_migrations(hash,created_at) values(${quote(hash)},${entry.when});`,
  `do $guard$ begin if (select md5(jsonb_agg(to_jsonb(t)-'id'-'change_request_of_key' order by key)::text) from whatsapp_templates t) is distinct from ${quote(sourceFingerprint)} then raise exception 'CHANGE_PREPARATION_EXISTING_TEMPLATES_CHANGED'; end if; end $guard$;`,
].join('\n');
const report = {
  source: 'production database snapshot; no live Meta lookup',
  migration: { tag: migrationTag, hash, through: entry.when },
  provider_submitted: false,
  merchant_activated: false,
  variants: plans.map((p) => ({
    ...p,
    variables: deriveDraftVariables(
      p.content.body,
      p.content.parameterFormat,
      p.content.samples,
    ),
    providerBody: providerBody(p.content),
    imageTwin: {
      key: p.key + '_logo',
      templateName: p.content.templateName + '_logo',
      parentKey: p.key,
      header: 'IMAGE',
      state: 'planned',
      body: p.content.body,
      providerBody: providerBody(p.content),
      buttons: [
        p.content.confirmLabel,
        p.content.cancelLabel,
        p.content.changeLabel,
      ],
    },
    state: 'draft',
    merchantOwn: {
      text: 'independent_approval_required',
      image: 'unsupported',
    },
  })),
};
const md = [
  '# Production three-button template review',
  '',
  'Drafts only. No provider submission, approval or activation is implied.',
  '',
  `Text drafts: ${plans.length}; image twin plans: ${plans.length}.`,
  'Body blocks omit trailing spaces for readability. The JSON export preserves exact whitespace and includes providerBody with the exact Meta parameter syntax for manual adoption.',
  '',
  'Review and submit text drafts in Admin > Templates, sync real provider results, and activate approved compatible counterparts without setting ordinary defaults. Review the image plans, then separately authorize Create missing twins (uploads/submits to Meta). Sync and activate usable approved twins. Own-number copies require independent text approval; image twins remain unsupported.',
  '',
  'For manual Meta creation, use each exact provider name and language code below. Use the declared parameter format and variable order. Match body and buttons exactly; image twins add an IMAGE header to that text parent. Never invent a provider ID or mark an unapproved template as ready. Reconcile/adopt the exact name-language identity through the existing authorized workflow.',
  '',
  ...report.variants.flatMap((p) => [
    `## ${p.content.language} / ${p.parentKey}`,
    '',
    `- Draft key: ${p.key}`,
    `- Provider identity: ${p.content.templateName} [${p.content.languageCode}]`,
    `- Category: ${p.content.category}; format: ${p.content.parameterFormat}; state: draft`,
    `- Twin: ${p.imageTwin.key}; ${p.imageTwin.templateName}; IMAGE; planned only`,
    ...(p.differences.length
      ? [`- Review finding: ${p.differences.join(', ')}`]
      : []),
    '',
    '```text',
    p.content.body,
    '```',
    '',
    'Provider body (use this exact parameter syntax in Meta):',
    '```text',
    p.providerBody,
    '```',
    '',
    `Buttons: ${p.content.confirmLabel} → ${p.content.cancelLabel} → ${p.content.changeLabel}`,
    '',
    'Samples:',
    '```json',
    JSON.stringify(p.variables, null, 2),
    '```',
    '',
  ]),
].join('\n');
fs.mkdirSync(outputPath, { recursive: true });
for (const [name, value] of [
  ['prepare-through-0093.sql', sql],
  ['review.json', JSON.stringify(report, null, 2)],
  ['review.md', md],
])
  fs.writeFileSync(
    path.join(outputPath, name),
    (name.endsWith('.md')
      ? value
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .join('\n')
      : value
    ).replace(/\r?\n/g, '\r\n'),
  );
console.log(
  JSON.stringify({
    drafts: plans.length,
    imageTwinPlans: plans.length,
    outputPath,
    findings: plans.flatMap((p) =>
      p.differences.map((reason) => ({ key: p.parentKey, reason })),
    ),
  }),
);
