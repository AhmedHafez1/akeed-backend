import {
  planTemplateCopy,
  type TemplateCopySkipReason,
} from './template-copy.policy';
import type { TemplateCopySubmission } from './template-draft.types';
import type { TemplateCategory } from './template-provider.types';
import type { RegistryTemplate } from './template-registry.types';
import type { TemplateTextModel } from './template-text.types';

/** The suffix a twin adds to its parent's provider name, key and style. */
export const IMAGE_TWIN_SUFFIX = '_logo';

/** Why a text template gets no image twin from the bulk action. */
export type ImageTwinSkipReason =
  | 'change_parent_unavailable'
  /** It already has one. */
  | 'has_twin'
  /** Staff retired it for good. */
  | 'retired'
  /** The provider's text could not be read. */
  | 'unreadable'
  /**
   * The parent's text cannot be copied: not synced, a text header (a
   * template has one header at most), a button that is not a quick reply, a
   * parameter mismatch or an unknown category.
   */
  | TemplateCopySkipReason;

export interface ImageTwinParent {
  changeRequestReady?: boolean;
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
  | { kind: 'create'; submission: TemplateCopySubmission }
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
  if (parent.changeRequestReady === false)
    return { kind: 'skip', reason: 'change_parent_unavailable' };
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
  return planTemplateCopy(template, parent.category, model, templateName);
}
