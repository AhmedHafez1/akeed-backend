import type { TemplateReviewStatus } from './template-provider.types';
import type { RegistryTemplate } from './template-registry.types';
import {
  previewBlocks,
  providerParameterOf,
  variablesByParameter,
} from './template-rendering';
import type {
  TemplateMessageLines,
  TemplateTextModel,
  TemplateTextSegment,
} from './template-text.types';

/**
 * - `not_synced`: this environment has never read the provider's templates.
 * - `missing`: the provider has no template under this name and language.
 * - `unreadable`: the provider's text could not be read, so nothing is compared.
 * - `drift`: the provider's template differs from what Akeed sends or previews.
 * - `in_sync`: no difference found.
 */
export type TemplateDriftState =
  | 'not_synced'
  | 'missing'
  | 'unreadable'
  | 'drift'
  | 'in_sync';

export type TemplateDriftKind =
  | 'parameter_format'
  | 'variables'
  | 'buttons'
  | 'button_labels'
  | 'body';

/**
 * `send` is a difference in what Akeed sends: the provider may refuse the
 * message or fill it wrongly. `preview` is a difference in the text only:
 * the message is delivered, but it does not read as Akeed shows it.
 */
export type TemplateDriftSeverity = 'send' | 'preview';

export interface TemplateDriftDifference {
  kind: TemplateDriftKind;
  severity: TemplateDriftSeverity;
  registered: string;
  provider: string;
}

export interface TemplateDrift {
  state: TemplateDriftState;
  differences: TemplateDriftDifference[];
}

const PREVIEW_TOKEN = /{{\s*([a-z_]+)\s*}}/gi;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The preview text with every variable written the same way, `{{key}}`. */
function registeredText(template: RegistryTemplate): string {
  return normalizeText(
    previewBlocks(template.preview)
      .join('\n')
      .replace(
        PREVIEW_TOKEN,
        (_token, key: string) => `{{${key.toLowerCase()}}}`,
      ),
  );
}

function parametersOf(model: TemplateTextModel): string[] {
  const seen = new Set<string>();
  for (const segments of [model.header, model.body, model.footer]) {
    for (const segment of segments ?? []) {
      if ('parameter' in segment) seen.add(segment.parameter);
    }
  }
  return [...seen];
}

/** The provider's text with each parameter named as the variable it carries. */
function providerText(
  template: RegistryTemplate,
  model: TemplateTextModel,
): string {
  const byParameter = variablesByParameter(template);
  const write = (segments: readonly TemplateTextSegment[] | undefined) =>
    (segments ?? [])
      .map((segment) =>
        'text' in segment
          ? segment.text
          : `{{${byParameter.get(segment.parameter)?.key ?? `?${segment.parameter}`}}}`,
      )
      .join('');
  return normalizeText(
    [model.header, model.body, model.footer].map(write).join('\n'),
  );
}

/**
 * Compares a registry template with the provider's copy of it. Akeed fills
 * the template's variables and two quick-reply buttons (confirm first, cancel
 * second), and shows merchants the hand-kept preview; each is checked.
 */
export function compareTemplateDrift(params: {
  template: RegistryTemplate;
  reviewStatus: TemplateReviewStatus | null;
  /** NULL when the provider's text is absent or could not be read. */
  model: TemplateTextModel | null;
  /**
   * What merchants are shown. With `provider` they read the provider's own
   * text, so the hand-kept preview is not compared.
   */
  previewSource?: TemplateMessageLines['source'];
}): TemplateDrift {
  const { template, model } = params;
  const previewsRegistered = params.previewSource !== 'provider';
  if (template.lastSyncedAt === null) {
    return { state: 'not_synced', differences: [] };
  }
  if (params.reviewStatus === 'missing') {
    return { state: 'missing', differences: [] };
  }
  if (!model) return { state: 'unreadable', differences: [] };

  const differences: TemplateDriftDifference[] = [];

  if (model.format !== template.parameterFormat) {
    differences.push({
      kind: 'parameter_format',
      severity: 'send',
      registered: template.parameterFormat,
      provider: model.format,
    });
  }

  const sent = template.variables.map((_variable, index) =>
    providerParameterOf(template, index),
  );
  const held = parametersOf(model);
  if (
    sent.some((parameter) => !held.includes(parameter)) ||
    held.some((parameter) => !sent.includes(parameter))
  ) {
    differences.push({
      kind: 'variables',
      severity: 'send',
      registered: [...sent].sort().join(', '),
      provider: [...held].sort().join(', '),
    });
  }

  const [confirm, cancel] = model.buttons;
  const twoQuickReplies =
    model.buttons.length === 2 &&
    confirm.kind === 'quick_reply' &&
    cancel.kind === 'quick_reply';
  if (!twoQuickReplies) {
    differences.push({
      kind: 'buttons',
      severity: 'send',
      registered: 'quick_reply, quick_reply',
      provider: model.buttons.map((button) => button.kind).join(', '),
    });
  } else if (
    previewsRegistered &&
    (confirm.text !== template.preview.confirmButton ||
      cancel.text !== template.preview.cancelButton)
  ) {
    differences.push({
      kind: 'button_labels',
      severity: 'preview',
      registered: `${template.preview.confirmButton} | ${template.preview.cancelButton}`,
      provider: `${confirm.text} | ${cancel.text}`,
    });
  }

  const registered = registeredText(template);
  const provider = providerText(template, model);
  if (previewsRegistered && registered !== provider) {
    differences.push({
      kind: 'body',
      severity: 'preview',
      registered,
      provider,
    });
  }

  return {
    state: differences.length > 0 ? 'drift' : 'in_sync',
    differences,
  };
}
