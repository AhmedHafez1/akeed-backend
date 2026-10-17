import type { ImageTwinSubmission } from './template-draft.types';
import type { TemplateCategory } from './template-provider.types';
import type { RegistryTemplate } from './template-registry.types';
import {
  templateSampleValues,
  variablesByParameter,
} from './template-rendering';
import type { TemplateTextModel } from './template-text.types';

/** The suffix a twin adds to its parent's provider name, key and style. */
export const IMAGE_TWIN_SUFFIX = '_logo';

/** Why a text template gets no image twin from the bulk action. */
export type ImageTwinSkipReason =
  /** It already has one. */
  | 'has_twin'
  /** Staff retired it for good. */
  | 'retired'
  /** No sync has stored the provider's text for it yet. */
  | 'not_synced'
  /** The provider's text could not be read. */
  | 'unreadable'
  /** It has a text header; a template has one header at most. */
  | 'text_header'
  /** A button that is not a quick reply cannot be copied. */
  | 'non_quick_reply_button'
  /** The provider's parameters do not match the registry's variables. */
  | 'format_mismatch'
  /** The provider's category is unknown, so none can be asked for. */
  | 'unknown_category';

export interface ImageTwinParent {
  template: Pick<
    RegistryTemplate,
    | 'key'
    | 'language'
    | 'templateName'
    | 'languageCode'
    | 'parameterFormat'
    | 'variables'
  >;
  category: TemplateCategory | null;
  retired: boolean;
}

export type ImageTwinPlan =
  | { kind: 'create'; submission: Omit<ImageTwinSubmission, 'headerHandle'> }
  /** The provider already holds the twin: register it, send nothing. */
  | { kind: 'adopt'; templateName: string }
  | { kind: 'skip'; reason: ImageTwinSkipReason };

/** `<name>_logo`, the twin's provider name. */
export function imageTwinName(templateName: string): string {
  return `${templateName}${IMAGE_TWIN_SUFFIX}`;
}

/**
 * Provider name and language, compared the way the sync compares them. A
 * provider name holds only lowercase letters, digits and underscores.
 */
export function providerIdentity(name: string, languageCode: string): string {
  return `${name}|${languageCode.replaceAll('-', '_')}`;
}

/**
 * What the bulk action does for one text template. The twin repeats the
 * parent's body, footer and quick replies exactly as the provider holds them,
 * with the sample values staff previews use, so its review is about the image
 * header alone. `providerIdentities` are the provider's own templates, read
 * once before the run: a twin already there is adopted, never sent again.
 */
export function planImageTwin(
  parent: ImageTwinParent,
  model: TemplateTextModel | null,
  context: {
    twinParentKeys: ReadonlySet<string>;
    providerIdentities: ReadonlySet<string>;
  },
): ImageTwinPlan {
  const { template } = parent;
  if (context.twinParentKeys.has(template.key)) {
    return { kind: 'skip', reason: 'has_twin' };
  }
  if (parent.retired) return { kind: 'skip', reason: 'retired' };
  const templateName = imageTwinName(template.templateName);
  if (
    context.providerIdentities.has(
      providerIdentity(templateName, template.languageCode),
    )
  ) {
    return { kind: 'adopt', templateName };
  }
  if (!model) return { kind: 'skip', reason: 'not_synced' };
  if (model.header) return { kind: 'skip', reason: 'text_header' };
  if (model.buttons.some((button) => button.kind !== 'quick_reply')) {
    return { kind: 'skip', reason: 'non_quick_reply_button' };
  }
  if (!parent.category || parent.category === 'unknown') {
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
      category: parent.category,
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
