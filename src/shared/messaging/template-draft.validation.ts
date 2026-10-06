import { EXPECTED_CATEGORY_BY_PURPOSE } from './template-provider.types';
import type {
  TemplateLanguage,
  TemplateParameterFormat,
  TemplatePurpose,
  TemplateVariableKey,
} from './template-registry.types';
import {
  TEMPLATE_VARIABLE_KEYS,
  type TemplateDraftContent,
  type TemplateDraftIssue,
  type TemplateDraftSamples,
  type TemplateDraftVariable,
  type TemplateSubmission,
} from './template-draft.types';
import type { TemplateTextSegment } from './template-text.types';

/**
 * The rules a staff-written template must pass before it is sent to the
 * provider (US-08-06 criterion 3). Every limit comes from the US-08-01
 * contract record; each rule names the finding it enforces. Nothing here
 * knows the provider's syntax: the body uses Akeed's own placeholders.
 */

/** Record 4.4.1. */
export const TEMPLATE_NAME_MAX_LENGTH = 512;
/** Record 4.6.7. */
export const TEMPLATE_BODY_MAX_LENGTH = 1024;
/** Record 4.7.2. */
export const TEMPLATE_BUTTON_LABEL_MAX_LENGTH = 25;
/** Keeps `<style>_v<n>` inside one 40-character part of a registry key. */
export const TEMPLATE_STYLE_MAX_LENGTH = 24;

/** Record 4.6.10: the codes the record lists, per Akeed language. */
export const TEMPLATE_LANGUAGE_CODES: Record<
  TemplateLanguage,
  readonly string[]
> = {
  ar: ['ar', 'ar_EG', 'ar_AE', 'ar_LB', 'ar_MA', 'ar_QA'],
  en: ['en', 'en_US', 'en_GB'],
};

/** How a purpose is written in a template name and in a registry key. */
export const TEMPLATE_PURPOSE_SLUG: Record<TemplatePurpose, string> = {
  cod_confirmation: 'cod_confirm',
  cod_reminder: 'cod_reminder',
};

/**
 * The quick replies a purpose must carry, in send order. The send path puts
 * the confirm payload on index 0 and the cancel payload on index 1 (record
 * 4.7.6), so a template whose first button is not its confirm button would
 * deliver "cancel" for a confirm tap.
 */
export const TEMPLATE_PURPOSE_BUTTONS: Record<
  TemplatePurpose,
  readonly ('confirm' | 'cancel')[]
> = {
  cod_confirmation: ['confirm', 'cancel'],
  cod_reminder: ['confirm', 'cancel'],
};

const STYLE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const VERSION_SUFFIX = /_v\d+$/;
const NAME_PATTERN = /^[a-z0-9_]+$/;
const NAMED_PARAMETER = /^[a-z_]+$/;
const TOKEN = /{{([^{}]*)}}/g;

/** `akeed_<purpose>_<style>_v<n>` (US-08-06 decision 1). */
export function buildTemplateName(
  purpose: TemplatePurpose,
  style: string,
  version: number,
): string {
  return `akeed_${TEMPLATE_PURPOSE_SLUG[purpose]}_${style}_v${version}`;
}

/** The style a registry row carries for a versioned draft. */
export function registryStyleOf(style: string, version: number): string {
  return `${style}_v${version}`;
}

export function buildDraftKey(
  purpose: TemplatePurpose,
  language: TemplateLanguage,
  style: string,
  version: number,
): string {
  return `${TEMPLATE_PURPOSE_SLUG[purpose]}.${language}.${registryStyleOf(style, version)}`;
}

/** Name and language as one identity, with `-` and `_` read alike. */
export function draftIdentity(name: string, languageCode: string): string {
  return `${name}\u0000${languageCode.trim().replaceAll('-', '_')}`;
}

export type DraftBodySegment =
  | { text: string }
  | { variable: TemplateVariableKey }
  | { unknown: string };

function isVariableKey(value: string): value is TemplateVariableKey {
  return (TEMPLATE_VARIABLE_KEYS as readonly string[]).includes(value);
}

/** Splits a draft body into text and `{{variable}}` placeholders. */
export function parseDraftBody(body: string): DraftBodySegment[] {
  const segments: DraftBodySegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(TOKEN)) {
    if (match.index > cursor) {
      segments.push({ text: body.slice(cursor, match.index) });
    }
    const name = match[1].trim();
    segments.push(isVariableKey(name) ? { variable: name } : { unknown: name });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor) });
  return segments;
}

/** The variables a body uses, in first-use order. */
export function draftVariableKeys(body: string): TemplateVariableKey[] {
  const keys: TemplateVariableKey[] = [];
  for (const segment of parseDraftBody(body)) {
    if ('variable' in segment && !keys.includes(segment.variable)) {
      keys.push(segment.variable);
    }
  }
  return keys;
}

/**
 * The mapping from each variable to its provider parameter: the variable's
 * own name for a named template, its first-use position for a positional one.
 */
export function deriveDraftVariables(
  body: string,
  format: TemplateParameterFormat,
  samples: TemplateDraftSamples,
): TemplateDraftVariable[] {
  return draftVariableKeys(body).map((key, index) => ({
    key,
    parameter: format === 'named' ? key : String(index + 1),
    sample: samples[key] ?? '',
  }));
}

/** The body with each variable replaced by its sample value. */
export function fillDraftBody(
  body: string,
  samples: TemplateDraftSamples,
): string {
  return parseDraftBody(body)
    .map((segment) =>
      'text' in segment
        ? segment.text
        : 'variable' in segment
          ? (samples[segment.variable] ?? '')
          : '',
    )
    .join('');
}

/** A draft in the neutral shape the provider port takes. */
export function toTemplateSubmission(
  content: TemplateDraftContent,
  variables: readonly TemplateDraftVariable[] = deriveDraftVariables(
    content.body,
    content.parameterFormat,
    content.samples,
  ),
): TemplateSubmission {
  const parameterOf = new Map(variables.map((v) => [v.key, v.parameter]));
  const body: TemplateTextSegment[] = parseDraftBody(content.body).map(
    (segment) =>
      'text' in segment
        ? { text: segment.text }
        : {
            parameter:
              'variable' in segment
                ? (parameterOf.get(segment.variable) ?? segment.variable)
                : segment.unknown,
          },
  );
  return {
    templateName: content.templateName,
    languageCode: content.languageCode,
    category: content.category,
    parameterFormat: content.parameterFormat,
    body,
    samples: variables.map(({ parameter, sample }) => ({ parameter, sample })),
    buttons: [
      { kind: 'quick_reply', text: content.confirmLabel },
      { kind: 'quick_reply', text: content.cancelLabel },
    ],
  };
}

type Issue = TemplateDraftIssue;

const error = (
  field: Issue['field'],
  rule: string,
  finding: string,
): Issue => ({ field, rule, finding, severity: 'error' });

/** Record 4.4.1, 4.4.3 and the naming convention (decision 1). */
export function validateName(
  content: Pick<
    TemplateDraftContent,
    'purpose' | 'style' | 'version' | 'templateName' | 'languageCode'
  >,
  takenIdentities: ReadonlySet<string>,
): Issue[] {
  const issues: Issue[] = [];
  if (
    !STYLE_PATTERN.test(content.style) ||
    content.style.length > TEMPLATE_STYLE_MAX_LENGTH ||
    VERSION_SUFFIX.test(content.style)
  ) {
    issues.push(error('style', 'style_format', 'akeed'));
  }
  if (
    !NAME_PATTERN.test(content.templateName) ||
    content.templateName.length > TEMPLATE_NAME_MAX_LENGTH
  ) {
    issues.push(error('name', 'name_format', '4.4.1'));
  }
  if (
    content.templateName !==
    buildTemplateName(content.purpose, content.style, content.version)
  ) {
    issues.push(error('name', 'name_convention', 'akeed'));
  }
  if (
    takenIdentities.has(
      draftIdentity(content.templateName, content.languageCode),
    )
  ) {
    issues.push(error('name', 'name_taken', '4.4.3'));
  }
  return issues;
}

/** Record 4.6.10 and 4.6.13: the exact code, from the record's list. */
export function validateLanguageCode(
  language: TemplateLanguage,
  languageCode: string,
): Issue[] {
  return TEMPLATE_LANGUAGE_CODES[language].includes(languageCode)
    ? []
    : [error('language_code', 'language_code_unsupported', '4.6.10')];
}

/** Record 4.5.1: the category the purpose is registered under. */
export function validateCategory(
  purpose: TemplatePurpose,
  category: string,
): Issue[] {
  return category === EXPECTED_CATEGORY_BY_PURPOSE[purpose]
    ? []
    : [error('category', 'category_not_allowed', '4.5.1')];
}

/** Record 4.6.7 and 4.6.8, and the variable set (decision 5). */
export function validateBody(body: string): Issue[] {
  const issues: Issue[] = [];
  const segments = parseDraftBody(body);
  if (body.trim().length === 0) {
    return [error('body', 'body_required', '4.6.7')];
  }
  if (body.length > TEMPLATE_BODY_MAX_LENGTH) {
    issues.push(error('body', 'body_too_long', '4.6.7'));
  }
  if (segments.some((segment) => 'unknown' in segment)) {
    issues.push(error('body', 'variable_unknown', 'akeed'));
  }
  if (
    segments.some((segment) => 'text' in segment && /[{}]/.test(segment.text))
  ) {
    issues.push(error('body', 'braces_mismatched', '4.6.8'));
  }
  const meaningful = segments.filter(
    (segment) => !('text' in segment) || segment.text.trim().length > 0,
  );
  const first = meaningful[0];
  const last = meaningful[meaningful.length - 1];
  if ((first && !('text' in first)) || (last && !('text' in last))) {
    issues.push(error('body', 'parameter_at_edge', '4.6.8'));
  }
  return issues;
}

/**
 * Record 4.6.14: the provider limits parameters per word but does not say by
 * how much, so this only warns, past one parameter per three words.
 */
export function validateParameterRatio(body: string): Issue[] {
  const segments = parseDraftBody(body);
  const parameters = segments.filter((segment) => !('text' in segment)).length;
  const words = segments
    .flatMap((segment) => ('text' in segment ? segment.text.split(/\s+/) : []))
    .filter((word) => word.length > 0).length;
  return parameters > 0 && parameters * 3 > words
    ? [
        {
          field: 'body',
          rule: 'parameter_ratio',
          finding: '4.6.14',
          severity: 'warning',
        },
      ]
    : [];
}

/**
 * Record 4.6.2 and 4.6.3, and that the mapping covers the body exactly
 * (criterion 3): a named parameter is unique lowercase letters and
 * underscores; positional parameters count from 1 without a gap.
 */
export function validateVariables(
  body: string,
  format: TemplateParameterFormat,
  variables: readonly TemplateDraftVariable[],
): Issue[] {
  const issues: Issue[] = [];
  const used = draftVariableKeys(body);
  const mapped = variables.map((variable) => variable.key);
  if (
    used.some((key) => !mapped.includes(key)) ||
    mapped.some((key) => !used.includes(key)) ||
    new Set(mapped).size !== mapped.length
  ) {
    issues.push(error('variables', 'mapping_incomplete', 'akeed'));
  }
  const parameters = variables.map((variable) => variable.parameter);
  if (format === 'named') {
    if (
      parameters.some((parameter) => !NAMED_PARAMETER.test(parameter)) ||
      new Set(parameters).size !== parameters.length
    ) {
      issues.push(error('variables', 'parameter_name_format', '4.6.2'));
    }
  } else if (
    parameters.some((parameter, index) => parameter !== String(index + 1))
  ) {
    issues.push(error('variables', 'parameter_numbering', '4.6.3'));
  }
  return issues;
}

/**
 * Record 4.6.4 and the 4.6.12 worst-case rule: every parameter has a sample,
 * each sample is one line, and the body filled with them stays under the
 * body limit.
 */
export function validateSamples(
  body: string,
  variables: readonly TemplateDraftVariable[],
): Issue[] {
  const issues: Issue[] = [];
  if (variables.some((variable) => variable.sample.trim().length === 0)) {
    issues.push(error('samples', 'sample_missing', '4.6.4'));
  }
  if (variables.some((variable) => /[\r\n]/.test(variable.sample))) {
    issues.push(error('samples', 'sample_multiline', '4.6.12'));
  }
  const samples = Object.fromEntries(
    variables.map((variable) => [variable.key, variable.sample]),
  ) as TemplateDraftSamples;
  if (fillDraftBody(body, samples).length >= TEMPLATE_BODY_MAX_LENGTH) {
    issues.push(error('samples', 'filled_body_too_long', '4.6.12'));
  }
  return issues;
}

/**
 * Record 4.7.1, 4.7.2 and the 4.7 worst-case rules: exactly the purpose's
 * quick replies, the confirm button first, each label within the limit.
 */
export function validateButtons(
  purpose: TemplatePurpose,
  buttons: TemplateSubmission['buttons'],
  labels: { confirmLabel: string; cancelLabel: string },
): Issue[] {
  const issues: Issue[] = [];
  const required = TEMPLATE_PURPOSE_BUTTONS[purpose];
  const expected = required.map((role) =>
    role === 'confirm' ? labels.confirmLabel : labels.cancelLabel,
  );
  if (labels.confirmLabel.trim().length === 0) {
    issues.push(error('confirm_label', 'button_label_required', '4.7.5'));
  }
  if (labels.cancelLabel.trim().length === 0) {
    issues.push(error('cancel_label', 'button_label_required', '4.7.5'));
  }
  if (labels.confirmLabel.length > TEMPLATE_BUTTON_LABEL_MAX_LENGTH) {
    issues.push(error('confirm_label', 'button_label_too_long', '4.7.2'));
  }
  if (labels.cancelLabel.length > TEMPLATE_BUTTON_LABEL_MAX_LENGTH) {
    issues.push(error('cancel_label', 'button_label_too_long', '4.7.2'));
  }
  if (
    labels.confirmLabel.trim().length > 0 &&
    labels.confirmLabel.trim() === labels.cancelLabel.trim()
  ) {
    issues.push(error('buttons', 'button_labels_identical', 'akeed'));
  }
  if (
    buttons.length !== required.length ||
    buttons.some((button) => button.kind !== 'quick_reply')
  ) {
    issues.push(error('buttons', 'button_count', '4.7.8'));
  } else if (buttons.some((button, index) => button.text !== expected[index])) {
    issues.push(error('buttons', 'button_order', '4.7.6'));
  }
  return issues;
}

export interface TemplateDraftValidation {
  issues: TemplateDraftIssue[];
  /** True when no issue is an error; warnings do not block a submit. */
  valid: boolean;
  variables: TemplateDraftVariable[];
}

/** Every rule, on one draft. */
export function validateTemplateDraft(
  content: TemplateDraftContent,
  context: { takenIdentities: ReadonlySet<string> },
): TemplateDraftValidation {
  const variables = deriveDraftVariables(
    content.body,
    content.parameterFormat,
    content.samples,
  );
  const submission = toTemplateSubmission(content, variables);
  const issues = [
    ...validateName(content, context.takenIdentities),
    ...validateLanguageCode(content.language, content.languageCode),
    ...validateCategory(content.purpose, content.category),
    ...validateBody(content.body),
    ...validateParameterRatio(content.body),
    ...validateVariables(content.body, content.parameterFormat, variables),
    ...validateSamples(content.body, variables),
    ...validateButtons(content.purpose, submission.buttons, content),
  ];
  return {
    issues,
    valid: issues.every((issue) => issue.severity !== 'error'),
    variables,
  };
}
