import type { SelectedCodTemplate } from './cod-template-selector';
import { isSendableReviewStatus } from './template-provider.types';
import type { ImageTwinTemplate } from './template-registry.types';
import type { TemplateSendGuardrail } from './template-selector';

/** What decides whether a store's message carries its banner. */
export interface LogoHeaderContext {
  /** Staff switched the logo header on for the store. */
  enabled: boolean;
  /** The store's banner, a public https URL, or null when none is saved. */
  bannerUrl: string | null | undefined;
  twins: readonly ImageTwinTemplate[];
  guardrail?: TemplateSendGuardrail;
}

export function isHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The image-header twin of the selected template, when the store may send it:
 * the switch is on, a banner is saved and the twin is active and, under the
 * guardrail, approved. Otherwise the selection comes back unchanged and the
 * text template goes out as before.
 *
 * The twin is found by the selected template's provider name and language,
 * so the store's choice, the reminder and Arabic `auto` all keep working: a
 * template without a twin is sent as text.
 */
export function applyLogoHeader(
  template: SelectedCodTemplate,
  context: LogoHeaderContext,
): SelectedCodTemplate {
  if (!context.enabled || !isHttpsUrl(context.bannerUrl)) return template;
  // The twins are not in the registry list `hasSyncedRegistry` reads, so a
  // twin the provider has not approved is held back whenever the guardrail is
  // on: an unapproved image template is the one most likely to be refused.
  const approvalRequired = context.guardrail?.enabled === true;
  const twin = context.twins.find(
    (candidate) =>
      candidate.twinOf.templateName === template.templateName &&
      candidate.twinOf.languageCode === template.languageCode &&
      candidate.isActive &&
      (!approvalRequired || isSendableReviewStatus(candidate.reviewStatus)),
  );
  if (!twin) return template;
  return {
    ...template,
    imageHeader: {
      templateName: twin.templateName,
      languageCode: twin.languageCode,
      imageUrl: context.bannerUrl,
    },
  };
}
