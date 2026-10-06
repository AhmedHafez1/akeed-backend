import type {
  RegistryTemplate,
  TemplateLanguage,
  TemplatePreview,
  TemplateVariable,
  TemplateVariableKey,
} from './template-registry.types';
import {
  templateDirection,
  type RenderedTemplateMessage,
  type TemplateMessageLines,
  type TemplateMessageSegment,
  type TemplateTextModel,
  type TemplateTextSegment,
} from './template-text.types';
import { TEMPLATE_VARIABLE_KEYS } from './template-draft.types';

export type TemplateSampleValues = Record<TemplateVariableKey, string>;

/** The order number and amount every test message carries. */
export const TEMPLATE_SAMPLE_ORDER_NUMBER = 'TEST-1';
export const TEMPLATE_SAMPLE_TOTAL = '250.00';
export const TEMPLATE_SAMPLE_CURRENCY = 'USD';
export const TEMPLATE_SAMPLE_CUSTOMER_NAMES = {
  ar: 'أحمد',
  en: 'Ahmed',
} as const satisfies Record<TemplateLanguage, string>;
const TEMPLATE_SAMPLE_STORE_NAMES = {
  ar: 'متجر أكيد',
  en: 'Akeed Store',
} as const satisfies Record<TemplateLanguage, string>;

/** The values staff see in a preview and receive in a staff test send. */
export function templateSampleValues(
  language: TemplateLanguage,
): TemplateSampleValues {
  return {
    customer: TEMPLATE_SAMPLE_CUSTOMER_NAMES[language],
    store: TEMPLATE_SAMPLE_STORE_NAMES[language],
    order: TEMPLATE_SAMPLE_ORDER_NUMBER,
    total: `${TEMPLATE_SAMPLE_TOTAL} ${TEMPLATE_SAMPLE_CURRENCY}`,
  };
}

/**
 * What the provider calls each variable of a registry template: its parameter
 * name, or its position (from 1) written as a string.
 */
export function providerParameterOf(
  template: Pick<RegistryTemplate, 'parameterFormat' | 'variables'>,
  index: number,
): string {
  const variable = template.variables[index];
  return template.parameterFormat === 'named'
    ? (variable.name ?? variable.key)
    : String(index + 1);
}

/** Provider parameter to the neutral variable it carries. */
export function variablesByParameter(
  template: Pick<RegistryTemplate, 'parameterFormat' | 'variables'>,
): Map<string, TemplateVariable> {
  return new Map(
    template.variables.map((variable, index) => [
      providerParameterOf(template, index),
      variable,
    ]),
  );
}

function toParagraphs(blocks: readonly string[]): string[] {
  return blocks
    .flatMap((block) => block.split(/\r?\n/g))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function fillSegments(
  segments: readonly TemplateTextSegment[] | undefined,
  byParameter: Map<string, TemplateVariable>,
  values: TemplateSampleValues,
): string {
  return (segments ?? [])
    .map((segment) => {
      if ('text' in segment) return segment.text;
      const variable = byParameter.get(segment.parameter);
      // A parameter the registry does not send has no value to show.
      return variable ? values[variable.key] : `[${segment.parameter}]`;
    })
    .join('');
}

/** The provider's text with sample values in place of its parameters. */
export function renderTemplateMessage(
  model: TemplateTextModel,
  template: Pick<
    RegistryTemplate,
    'language' | 'parameterFormat' | 'variables'
  >,
  values: TemplateSampleValues = templateSampleValues(template.language),
): RenderedTemplateMessage {
  const byParameter = variablesByParameter(template);
  return {
    paragraphs: toParagraphs(
      [model.header, model.body, model.footer].map((segments) =>
        fillSegments(segments, byParameter, values),
      ),
    ),
    buttons: model.buttons.map((button) => ({
      label: button.text,
      kind: button.kind,
    })),
    direction: templateDirection(template.language),
  };
}

const PREVIEW_TOKEN = /{{\s*([a-z_]+)\s*}}/gi;

/** The hand-kept preview blocks, in the order they are shown. */
export function previewBlocks(preview: TemplatePreview): string[] {
  return [preview.greeting, preview.body, preview.totalLabel, preview.ending];
}

/** The hand-kept preview Settings shows merchants, with sample values. */
export function renderRegisteredPreview(
  template: Pick<RegistryTemplate, 'language' | 'preview'>,
  values: TemplateSampleValues = templateSampleValues(template.language),
): RenderedTemplateMessage {
  const fill = (block: string) =>
    block.replace(PREVIEW_TOKEN, (token, key: string) =>
      Object.hasOwn(values, key.toLowerCase())
        ? values[key.toLowerCase() as TemplateVariableKey]
        : token,
    );
  return {
    paragraphs: toParagraphs(previewBlocks(template.preview).map(fill)),
    buttons: [
      { label: template.preview.confirmButton, kind: 'quick_reply' },
      { label: template.preview.cancelButton, kind: 'quick_reply' },
    ],
    direction: templateDirection(template.language),
  };
}

/**
 * Splits segments into lines at their line breaks, trims each line's ends and
 * drops empty lines, joining neighbouring text.
 */
function toLines(
  blocks: readonly (readonly TemplateMessageSegment[])[],
): TemplateMessageSegment[][] {
  const lines: TemplateMessageSegment[][] = [];
  let current: TemplateMessageSegment[] = [];
  const push = (segment: TemplateMessageSegment) => {
    const last = current[current.length - 1];
    if ('text' in segment && last && 'text' in last) {
      current[current.length - 1] = { text: last.text + segment.text };
    } else {
      current.push(segment);
    }
  };
  const close = () => {
    const trimmed = trimLine(current);
    if (trimmed.length) lines.push(trimmed);
    current = [];
  };
  for (const block of blocks) {
    for (const segment of block) {
      if (!('text' in segment)) {
        push(segment);
        continue;
      }
      const parts = segment.text.split(/\r?\n/g);
      parts.forEach((part, index) => {
        if (index > 0) close();
        if (part) push({ text: part });
      });
    }
    close();
  }
  return lines;
}

function trimLine(line: TemplateMessageSegment[]): TemplateMessageSegment[] {
  const result = [...line];
  const first = result[0];
  if (first && 'text' in first) {
    const text = first.text.trimStart();
    if (text) result[0] = { text };
    else result.shift();
  }
  const last = result[result.length - 1];
  if (last && 'text' in last) {
    const text = last.text.trimEnd();
    if (text) result[result.length - 1] = { text };
    else result.pop();
  }
  return result;
}

function isVariableKey(value: string): value is TemplateVariableKey {
  return (TEMPLATE_VARIABLE_KEYS as readonly string[]).includes(value);
}

/** The provider's text, with each parameter named by the value it carries. */
export function messageLinesFromProvider(
  model: TemplateTextModel,
  template: Pick<
    RegistryTemplate,
    'language' | 'parameterFormat' | 'variables'
  >,
): TemplateMessageLines {
  const byParameter = variablesByParameter(template);
  const segmentsOf = (
    segments: readonly TemplateTextSegment[] | undefined,
  ): TemplateMessageSegment[] =>
    (segments ?? []).map((segment) => {
      if ('text' in segment) return { text: segment.text };
      const variable = byParameter.get(segment.parameter);
      // A parameter the registry does not send has no value to show.
      return variable
        ? { variable: variable.key }
        : { text: `[${segment.parameter}]` };
    });
  return {
    lines: toLines([
      segmentsOf(model.header),
      segmentsOf(model.body),
      segmentsOf(model.footer),
    ]),
    buttons: model.buttons.map((button) => button.text),
    direction: templateDirection(template.language),
    source: 'provider',
  };
}

/** The stored preview blocks, with `{{key}}` read as the value it names. */
export function messageLinesFromRegistered(
  template: Pick<RegistryTemplate, 'language' | 'preview'>,
): TemplateMessageLines {
  const segmentsOf = (block: string): TemplateMessageSegment[] => {
    const segments: TemplateMessageSegment[] = [];
    let cursor = 0;
    for (const match of block.matchAll(PREVIEW_TOKEN)) {
      const key = match[1].toLowerCase();
      if (!isVariableKey(key)) continue;
      if (match.index > cursor) {
        segments.push({ text: block.slice(cursor, match.index) });
      }
      segments.push({ variable: key });
      cursor = match.index + match[0].length;
    }
    if (cursor < block.length) segments.push({ text: block.slice(cursor) });
    return segments;
  };
  return {
    lines: toLines(previewBlocks(template.preview).map(segmentsOf)),
    buttons: [template.preview.confirmButton, template.preview.cancelButton],
    direction: templateDirection(template.language),
    source: 'registered',
  };
}
