#!/usr/bin/env node

// Compares a saved template list with
// src/shared/messaging/cod-template-catalog.ts for US-08-01.
// Offline: it reads files and calls nothing.
//
//   node scripts/spikes/whatsapp-templates/reconcile.mjs --env dev
//   node scripts/spikes/whatsapp-templates/reconcile.mjs --env dev --compare prod
//
// Reads .tmp/spikes/whatsapp-templates/<env>/templates.json, written by
// list-templates.mjs, and writes reconciliation.json and reconciliation.md
// next to it. With `--compare` it also writes comparison-<env>-vs-<other>.md.
//
// The catalog is imported as TypeScript, which needs Node 22.18 or newer. Node
// prints a MODULE_TYPELESS_PACKAGE_JSON warning for it; that is harmless.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKEND_ROOT, evidenceDir, parseArgs } from './lib.mjs';

const CATALOG_PATH = path.join(
  BACKEND_ROOT,
  'src',
  'shared',
  'messaging',
  'cod-template-catalog.ts',
);
const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const KNOWN_COMPONENTS = ['HEADER', 'BODY', 'FOOTER', 'BUTTONS'];
const PREVIEW_BLOCKS = ['greeting', 'body', 'totalLabel', 'ending'];

// Code points are written as numbers on purpose: an escape typed through a
// tool can turn into the raw character it names.
const INVISIBLE_SINGLES = new Set([
  0x00a0, 0x00ad, 0x061c, 0x0640, 0xfe0f, 0xfeff,
]);
const INVISIBLE_RANGES = [
  [0x0000, 0x0009],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
];

const relative = (file) => path.relative(BACKEND_ROOT, file);
const keyOf = (name, language) => `${name}|${language}`;
const upper = (value) => String(value ?? '').toUpperCase();
const collapse = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const words = (text) =>
  String(text ?? '')
    .split(/\s+/)
    .filter(Boolean);
const variablesIn = (text) =>
  [...String(text ?? '').matchAll(VARIABLE)].map((match) => match[1]);
const qualityOf = (template) =>
  template.quality_score && typeof template.quality_score === 'object'
    ? (template.quality_score.score ?? null)
    : (template.quality_score ?? null);

function loadRun(env) {
  const file = path.join(evidenceDir(env), 'templates.json');
  if (!existsSync(file)) {
    console.error(
      `No run at ${relative(file)}. Run list-templates.mjs --env ${env} first.`,
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function componentOf(template, type) {
  return (
    (template.components ?? []).find((entry) => upper(entry.type) === type) ??
    null
  );
}

function countBy(list) {
  const counts = {};
  for (const item of list) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function invisibles(text) {
  const counts = new Map();
  for (const char of String(text ?? '')) {
    const codePoint = char.codePointAt(0);
    const hit =
      INVISIBLE_SINGLES.has(codePoint) ||
      INVISIBLE_RANGES.some(
        ([from, to]) => codePoint >= from && codePoint <= to,
      );
    if (!hit) continue;
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label}x${count}`);
}

// Word-level diff. `[-word-]` is only in the catalog, `{+word+}` only at Meta.
function wordDiff(catalogText, metaText) {
  const left = words(catalogText);
  const right = words(metaText);
  const table = Array.from({ length: left.length + 1 }, () =>
    new Array(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push(left[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`[-${left[i]}-]`);
      i += 1;
    } else {
      out.push(`{+${right[j]}+}`);
      j += 1;
    }
  }
  while (i < left.length) out.push(`[-${left[i++]}-]`);
  while (j < right.length) out.push(`{+${right[j++]}+}`);
  return out.join(' ');
}

function reconcileVariant(definition, template, templates) {
  const base = {
    language: definition.language,
    variant: definition.variant,
    metaTemplateName: definition.metaTemplateName,
    metaLanguageCode: definition.metaLanguageCode,
    codeParameterFormat: definition.bodyVariableMode,
    codeParameterOrder: definition.bodyParameterOrder,
  };
  if (!template) {
    return {
      ...base,
      found: false,
      languagesAtMetaForThisName: templates
        .filter((entry) => entry.name === definition.metaTemplateName)
        .map((entry) => entry.language),
    };
  }

  const codeOrder = definition.bodyParameterOrder;
  const positional = definition.bodyVariableMode === 'positional';
  const metaBody = String(componentOf(template, 'BODY')?.text ?? '');
  const header = componentOf(template, 'HEADER');
  const footer = componentOf(template, 'FOOTER');
  const buttons = componentOf(template, 'BUTTONS')?.buttons ?? [];
  const metaVariables = [...new Set(variablesIn(metaBody))];
  const metaFormat = template.parameter_format
    ? String(template.parameter_format).toLowerCase()
    : `${metaVariables.every((name) => /^\d+$/.test(name)) ? 'positional' : 'named'} (inferred)`;

  // A positional Meta body is rewritten with the keys the code sends in each
  // position, so it can be read against the catalog preview.
  const comparableBody = positional
    ? metaBody.replace(VARIABLE, (whole, name) => {
        const key = codeOrder[Number(name) - 1];
        return key ? `{{${key}}}` : whole;
      })
    : metaBody;
  const expected = positional
    ? codeOrder.map((_, index) => String(index + 1))
    : codeOrder;
  const metaOnly = metaVariables.filter((name) => !expected.includes(name));
  const codeOnly = expected.filter((name) => !metaVariables.includes(name));
  const formatMatches = metaFormat.startsWith(definition.bodyVariableMode);

  const previewJoined = PREVIEW_BLOCKS.map((name) => definition.preview[name])
    .filter((text) => text !== '')
    .join('\n');
  const collapsedMeta = collapse(comparableBody);
  const catalogButtons = [
    definition.preview.confirmButton,
    definition.preview.cancelButton,
  ];
  const buttonRows = Array.from(
    { length: Math.max(buttons.length, catalogButtons.length) },
    (_, index) => ({
      index,
      sentPayload: ['confirm_<id>', 'cancel_<id>'][index] ?? null,
      metaType: buttons[index]?.type ?? null,
      metaText: buttons[index]?.text ?? null,
      catalogText: catalogButtons[index] ?? null,
      textMatches: buttons[index]?.text === catalogButtons[index],
    }),
  );

  return {
    ...base,
    found: true,
    status: template.status ?? null,
    category: template.category ?? null,
    quality: qualityOf(template),
    subCategory: template.sub_category ?? null,
    previousCategory: template.previous_category ?? null,
    correctCategory: template.correct_category ?? null,
    rejectedReason: template.rejected_reason ?? null,
    metaParameterFormat: metaFormat,
    parameters: {
      formatMatches,
      metaVariables,
      codeSends: expected,
      atMetaButNotSent: metaOnly,
      sentButNotAtMeta: codeOnly,
      match: formatMatches && metaOnly.length === 0 && codeOnly.length === 0,
    },
    header: header
      ? { format: header.format ?? null, text: header.text ?? null }
      : null,
    footer: footer ? (footer.text ?? null) : null,
    otherComponents: (template.components ?? [])
      .map((entry) => upper(entry.type))
      .filter((type) => !KNOWN_COMPONENTS.includes(type)),
    body: {
      meta: metaBody,
      metaWithCodeKeys: comparableBody,
      catalogPreview: previewJoined,
      exact: comparableBody === previewJoined,
      sameIgnoringWhitespace: collapsedMeta === collapse(previewJoined),
      wordDiff: wordDiff(previewJoined, comparableBody),
      invisibleAtMeta: invisibles(metaBody),
      invisibleInCatalog: invisibles(previewJoined),
      variableCounts: {
        catalogPreview: countBy(variablesIn(previewJoined)),
        meta: countBy(variablesIn(comparableBody)),
      },
      blocks: PREVIEW_BLOCKS.map((name) => {
        const text = definition.preview[name];
        return {
          block: name,
          text,
          inMetaBody:
            text === ''
              ? 'empty'
              : collapsedMeta.includes(collapse(text))
                ? 'yes'
                : 'no',
        };
      }),
    },
    buttons: {
      rows: buttonRows,
      match:
        buttons.length === 2 &&
        buttons.every((button) => upper(button.type) === 'QUICK_REPLY') &&
        buttonRows.every((row) => row.textMatches),
    },
  };
}

const cell = (value) =>
  String(value ?? '-')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
const tableRow = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const quoted = (text) => `\`${JSON.stringify(text)}\``;

function bodyVerdict(body) {
  if (body.exact) return 'exact';
  return body.sameIgnoringWhitespace ? 'whitespace only' : 'differs';
}

function renderReconciliation(env, run, variants, unused) {
  const lines = [
    `# Template reconciliation: ${env}`,
    '',
    `- Run: ${run.meta.ranAt}, Graph ${run.meta.graphApiVersion}, kit ${run.meta.kitFingerprint}`,
    `- Templates at Meta: ${run.templates.length}`,
    `- Fields Graph rejected: ${run.meta.droppedFields?.join(', ') || 'none'}`,
    '',
    '## Summary',
    '',
    tableRow([
      'Lang',
      'Variant',
      'Meta name',
      'Code',
      'Found',
      'Status',
      'Category',
      'Quality',
      'Format Meta / code',
      'Params',
      'Body',
      'Buttons',
      'Header',
      'Footer',
    ]),
    tableRow(new Array(14).fill('---')),
  ];
  for (const entry of variants) {
    lines.push(
      tableRow(
        entry.found
          ? [
              entry.language,
              entry.variant,
              `\`${entry.metaTemplateName}\``,
              `\`${entry.metaLanguageCode}\``,
              'yes',
              entry.status,
              entry.category,
              entry.quality,
              `${entry.metaParameterFormat} / ${entry.codeParameterFormat}`,
              entry.parameters.match ? 'match' : 'differ',
              bodyVerdict(entry.body),
              entry.buttons.match ? 'match' : 'differ',
              entry.header ? 'yes' : 'no',
              entry.footer ? 'yes' : 'no',
            ]
          : [
              entry.language,
              entry.variant,
              `\`${entry.metaTemplateName}\``,
              `\`${entry.metaLanguageCode}\``,
              '**MISSING**',
              ...new Array(9).fill('-'),
            ],
      ),
    );
  }

  lines.push('', '## Per variant', '');
  for (const entry of variants) {
    lines.push(
      `### ${entry.language} / ${entry.variant}: \`${entry.metaTemplateName}\` [\`${entry.metaLanguageCode}\`]`,
      '',
    );
    if (!entry.found) {
      lines.push(
        `Not at Meta in this language. Languages at Meta for this name: ${entry.languagesAtMetaForThisName.join(', ') || 'none'}.`,
        '',
      );
      continue;
    }
    lines.push(
      `- Status ${entry.status}, category ${entry.category}, quality ${entry.quality}`,
      `- Category fields: sub ${entry.subCategory ?? '-'}, previous ${entry.previousCategory ?? '-'}, correct ${entry.correctCategory ?? '-'}; rejected reason ${entry.rejectedReason ?? '-'}`,
      `- Parameter format: Meta ${entry.metaParameterFormat}, code ${entry.codeParameterFormat}`,
      `- Meta variables: ${entry.parameters.metaVariables.join(', ') || 'none'}; code sends: ${entry.parameters.codeSends.join(', ')}`,
      `- At Meta but not sent: ${entry.parameters.atMetaButNotSent.join(', ') || 'none'}; sent but not at Meta: ${entry.parameters.sentButNotAtMeta.join(', ') || 'none'}`,
      `- Header: ${entry.header ? `${entry.header.format} ${quoted(entry.header.text)}` : 'none'}; footer: ${entry.footer ? quoted(entry.footer) : 'none'}; other components: ${entry.otherComponents.join(', ') || 'none'}`,
      `- Body: ${bodyVerdict(entry.body)}`,
      `- Invisible characters: Meta ${entry.body.invisibleAtMeta.join(' ') || 'none'}; catalog ${entry.body.invisibleInCatalog.join(' ') || 'none'}`,
      `- Variable counts: catalog ${JSON.stringify(entry.body.variableCounts.catalogPreview)}, Meta ${JSON.stringify(entry.body.variableCounts.meta)}`,
      '',
      `Meta body: ${quoted(entry.body.meta)}`,
      '',
      `Catalog preview: ${quoted(entry.body.catalogPreview)}`,
      '',
      'Word diff (`[-catalog only-]`, `{+Meta only+}`):',
      '',
      '```text',
      entry.body.wordDiff,
      '```',
      '',
      tableRow(['Preview block', 'In Meta body', 'Catalog text']),
      tableRow(['---', '---', '---']),
      ...entry.body.blocks.map((block) =>
        tableRow([block.block, block.inMetaBody, quoted(block.text)]),
      ),
      '',
      tableRow([
        'Index',
        'Payload sent',
        'Meta type',
        'Meta label',
        'Catalog label',
        'Same',
      ]),
      tableRow(new Array(6).fill('---')),
      ...entry.buttons.rows.map((row) =>
        tableRow([
          row.index,
          row.sentPayload,
          row.metaType,
          row.metaText,
          row.catalogText,
          row.textMatches ? 'yes' : 'no',
        ]),
      ),
      '',
    );
  }

  lines.push('## Meta templates the catalog does not use', '');
  if (unused.length === 0) lines.push('None.');
  for (const template of unused) {
    lines.push(
      `- \`${template.name}\` [\`${template.language}\`]: ${template.status}, ${template.category}, quality ${qualityOf(template) ?? '-'}`,
    );
  }
  lines.push('', '## Catalog entries missing at Meta', '');
  const missing = variants.filter((entry) => !entry.found);
  if (missing.length === 0) lines.push('None.');
  for (const entry of missing) {
    lines.push(
      `- ${entry.language} / ${entry.variant}: \`${entry.metaTemplateName}\` [\`${entry.metaLanguageCode}\`]`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderComparison(env, other, run, otherRun) {
  const index = (source) =>
    new Map(
      source.templates.map((template) => [
        keyOf(template.name, template.language),
        template,
      ]),
    );
  const left = index(run);
  const right = index(otherRun);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const pair = (a, b) => (a === b ? (a ?? '-') : `${a ?? '-'} / ${b ?? '-'}`);
  const lines = [
    `# Template comparison: ${env} against ${other}`,
    '',
    `- ${env}: ${run.meta.ranAt}, ${run.templates.length} templates`,
    `- ${other}: ${otherRun.meta.ranAt}, ${otherRun.templates.length} templates`,
    '',
    `Where the two differ a cell reads \`${env} / ${other}\`.`,
    '',
    tableRow([
      'Template',
      'Language',
      `In ${env}`,
      `In ${other}`,
      'Status',
      'Category',
      'Quality',
      'Format',
      'Components identical',
    ]),
    tableRow(new Array(9).fill('---')),
  ];
  for (const key of keys) {
    const a = left.get(key);
    const b = right.get(key);
    const [name, language] = key.split('|');
    lines.push(
      tableRow([
        `\`${name}\``,
        `\`${language}\``,
        a ? 'yes' : '**no**',
        b ? 'yes' : '**no**',
        pair(a?.status, b?.status),
        pair(a?.category, b?.category),
        pair(a && qualityOf(a), b && qualityOf(b)),
        pair(a?.parameter_format, b?.parameter_format),
        a && b
          ? JSON.stringify(a.components) === JSON.stringify(b.components)
            ? 'yes'
            : '**no**'
          : '-',
      ]),
    );
  }
  return `${lines.join('\n')}\n`;
}

const { flags } = parseArgs(process.argv.slice(2));
if (typeof flags.env !== 'string') {
  console.error(
    'Usage: node scripts/spikes/whatsapp-templates/reconcile.mjs --env dev|prod [--compare prod|dev]',
  );
  process.exit(1);
}

const catalog = await import(pathToFileURL(CATALOG_PATH).href);
const definitions = catalog.getAvailableCodTemplateDefinitions();
const run = loadRun(flags.env);
const byKey = new Map(
  run.templates.map((template) => [
    keyOf(template.name, template.language),
    template,
  ]),
);
const variants = [...definitions.ar, ...definitions.en].map((definition) =>
  reconcileVariant(
    definition,
    byKey.get(keyOf(definition.metaTemplateName, definition.metaLanguageCode)),
    run.templates,
  ),
);
const usedKeys = new Set(
  variants.map((entry) =>
    keyOf(entry.metaTemplateName, entry.metaLanguageCode),
  ),
);
const unused = run.templates.filter(
  (template) => !usedKeys.has(keyOf(template.name, template.language)),
);

const dir = evidenceDir(flags.env);
const markdown = renderReconciliation(flags.env, run, variants, unused);
writeFileSync(
  path.join(dir, 'reconciliation.json'),
  `${JSON.stringify(
    {
      env: flags.env,
      run: run.meta,
      variants,
      unusedAtMeta: unused.map((template) => ({
        name: template.name,
        language: template.language,
        status: template.status ?? null,
        category: template.category ?? null,
        quality: qualityOf(template),
      })),
    },
    null,
    2,
  )}\n`,
);
writeFileSync(path.join(dir, 'reconciliation.md'), markdown);
process.stdout.write(markdown);
console.error(`\nWrote ${relative(path.join(dir, 'reconciliation.md'))}`);

if (typeof flags.compare === 'string') {
  const comparison = renderComparison(
    flags.env,
    flags.compare,
    run,
    loadRun(flags.compare),
  );
  const file = path.join(dir, `comparison-${flags.env}-vs-${flags.compare}.md`);
  writeFileSync(file, comparison);
  process.stdout.write(`\n${comparison}`);
  console.error(`\nWrote ${relative(file)}`);
}
