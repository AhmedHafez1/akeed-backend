import type { TemplateCopySubmission } from './template-draft.types';
import type { TemplateCategory } from './template-provider.types';
import type { RegistryTemplate } from './template-registry.types';
import {
  templateSampleValues,
  variablesByParameter,
} from './template-rendering';
import type { TemplateTextModel } from './template-text.types';

/** Why a synced template cannot be submitted again as it is. */
export type TemplateCopySkipReason =
  /** No sync has stored the provider's text for it yet. */
  | 'not_synced'
  /** It has a text header, which this copy does not carry. */
  | 'text_header'
  /** A button that is not a quick reply cannot be copied. */
  | 'non_quick_reply_button'
  /** The provider's parameters do not match the registry's variables. */
  | 'format_mismatch'
  /** The category is unknown, so none can be asked for. */
  | 'unknown_category';

export type TemplateCopyPlan =
  | { kind: 'create'; submission: TemplateCopySubmission }
  | { kind: 'skip'; reason: TemplateCopySkipReason };

export type TemplateCopySource = Pick<
  RegistryTemplate,
  'language' | 'languageCode' | 'parameterFormat' | 'variables'
>;

/**
 * A synced template's text, ready to be created again under `templateName`:
 * the body, footer and quick replies exactly as the provider holds them, with
 * the sample values staff previews use. Only what this copy can repeat
 * faithfully is submitted; anything else is a skip with its reason.
 */
export function planTemplateCopy(
  template: TemplateCopySource,
  category: TemplateCategory | null,
  model: TemplateTextModel | null,
  templateName: string,
): TemplateCopyPlan {
  if (!model) return { kind: 'skip', reason: 'not_synced' };
  if (model.header) return { kind: 'skip', reason: 'text_header' };
  if (model.buttons.some((button) => button.kind !== 'quick_reply')) {
    return { kind: 'skip', reason: 'non_quick_reply_button' };
  }
  if (!category || category === 'unknown') {
    return { kind: 'skip', reason: 'unknown_category' };
  }

  const parameters = [
    ...new Set(
      model.body.flatMap((segment) =>
        'parameter' in segment ? [segment.parameter] : [],
      ),
    ),
  ];
  const expectedFormat =
    template.variables.length === 0 ? 'none' : template.parameterFormat;
  if (model.format !== expectedFormat) {
    return { kind: 'skip', reason: 'format_mismatch' };
  }
  const variables = variablesByParameter(template);
  const values = templateSampleValues(template.language);
  const samples: { parameter: string; sample: string }[] = [];
  for (const parameter of parameters) {
    const variable = variables.get(parameter);
    if (!variable) return { kind: 'skip', reason: 'format_mismatch' };
    samples.push({ parameter, sample: values[variable.key] });
  }

  return {
    kind: 'create',
    submission: {
      templateName,
      languageCode: template.languageCode,
      category,
      parameterFormat: model.format,
      body: model.body,
      ...(model.footer ? { footer: model.footer } : {}),
      samples,
      buttons: model.buttons.map((button) => ({
        kind: 'quick_reply' as const,
        text: button.text,
      })),
    },
  };
}
