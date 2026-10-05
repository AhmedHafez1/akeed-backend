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
  type TemplateTextModel,
  type TemplateTextSegment,
} from './template-text.types';

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
