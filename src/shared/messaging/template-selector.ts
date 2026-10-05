import type { SelectedCodTemplate } from './cod-template-selector';
import { resolveTemplateLanguageForPhone } from './template-language';
import {
  COD_CONFIRMATION_PURPOSE,
  buildCodConfirmationKey,
  type RegistryTemplate,
  type TemplateLanguage,
  type TemplatePurpose,
} from './template-registry.types';

/** Why a store's stored choice was not used and the default was. */
export type TemplateFallbackReason =
  | 'key_missing'
  | 'key_unknown'
  | 'key_inactive'
  | 'wrong_language';

export type TemplateResolution =
  | {
      template: RegistryTemplate;
      /** Present when the language default stood in for the stored choice. */
      fallbackReason?: TemplateFallbackReason;
    }
  | { template: null; reason: 'default_unavailable' };

/**
 * The registry key a store has chosen for one language.
 *
 * While the old variant columns exist (until the migration after the US-08-08
 * gate drops them), a store without a stored key is read from its old variant.
 * That covers a source created after the key columns were added, which starts
 * with no key.
 */
export function storedTemplateKey(params: {
  language: TemplateLanguage;
  key?: string | null;
  legacyVariant?: string | null;
}): string | null {
  if (params.key) return params.key;
  return params.legacyVariant
    ? buildCodConfirmationKey(params.language, params.legacyVariant)
    : null;
}

/** The active templates a merchant may choose from, in display order. */
export function selectableTemplates(
  templates: readonly RegistryTemplate[],
  language: TemplateLanguage,
  purpose: TemplatePurpose = COD_CONFIRMATION_PURPOSE,
): RegistryTemplate[] {
  return templates.filter(
    (template) =>
      template.isActive &&
      template.purpose === purpose &&
      template.language === language,
  );
}

export function findSelectableByStyle(
  templates: readonly RegistryTemplate[],
  language: TemplateLanguage,
  style: string,
): RegistryTemplate | undefined {
  return selectableTemplates(templates, language).find(
    (template) => template.style === style,
  );
}

export function findDefaultTemplate(
  templates: readonly RegistryTemplate[],
  language: TemplateLanguage,
  purpose: TemplatePurpose = COD_CONFIRMATION_PURPOSE,
): RegistryTemplate | undefined {
  return selectableTemplates(templates, language, purpose).find(
    (template) => template.isDefault,
  );
}

/**
 * Resolves a stored choice to a template that may be sent. A choice that is
 * missing, unknown, inactive or written for another language falls back to
 * the language default and says why. With no default there is nothing to
 * send: the caller skips, it never picks another template.
 */
export function resolveTemplate(
  templates: readonly RegistryTemplate[],
  params: {
    language: TemplateLanguage;
    storedKey: string | null;
    purpose?: TemplatePurpose;
  },
): TemplateResolution {
  const purpose = params.purpose ?? COD_CONFIRMATION_PURPOSE;
  const stored = params.storedKey
    ? templates.find((template) => template.key === params.storedKey)
    : undefined;

  let fallbackReason: TemplateFallbackReason;
  if (!params.storedKey) {
    fallbackReason = 'key_missing';
  } else if (!stored) {
    fallbackReason = 'key_unknown';
  } else if (
    stored.language !== params.language ||
    stored.purpose !== purpose
  ) {
    fallbackReason = 'wrong_language';
  } else if (!stored.isActive) {
    fallbackReason = 'key_inactive';
  } else {
    return { template: stored };
  }

  const fallback = findDefaultTemplate(templates, params.language, purpose);
  return fallback
    ? { template: fallback, fallbackReason }
    : { template: null, reason: 'default_unavailable' };
}

export type TemplateSelection =
  | {
      template: SelectedCodTemplate;
      /** The key the store had stored, when it was not the one used. */
      storedKey: string | null;
      fallbackReason?: TemplateFallbackReason;
    }
  | {
      template: null;
      language: TemplateLanguage;
      storedKey: string | null;
      reason: 'default_unavailable';
    };

/** What an adapter needs to send a registry template. */
export function toSelectedTemplate(
  template: RegistryTemplate,
): SelectedCodTemplate {
  return {
    variantKey: `${template.language}.${template.style}`,
    language: template.language,
    templateName: template.templateName,
    languageCode: template.languageCode,
    parameterFormat: template.parameterFormat,
    variables: template.variables,
  };
}

/**
 * Picks the template for one send from the store's settings and the
 * customer's number. It runs before the dispatch is claimed, so the ledger
 * records the same values the message is built from.
 *
 * The store's forced language wins; `auto` follows the number, and a missing
 * number is read like a local number without a country code.
 */
export function selectTemplateForSend(
  templates: readonly RegistryTemplate[],
  params: {
    preferredLanguage?: string | null;
    phoneNumber: string | null | undefined;
    arKey?: string | null;
    enKey?: string | null;
    arLegacyVariant?: string | null;
    enLegacyVariant?: string | null;
  },
): TemplateSelection {
  const language = resolveTemplateLanguageForPhone(
    params.preferredLanguage,
    params.phoneNumber ?? '',
  );
  const storedKey = storedTemplateKey(
    language === 'ar'
      ? { language, key: params.arKey, legacyVariant: params.arLegacyVariant }
      : { language, key: params.enKey, legacyVariant: params.enLegacyVariant },
  );
  const resolution = resolveTemplate(templates, { language, storedKey });
  if (!resolution.template) {
    return { template: null, language, storedKey, reason: resolution.reason };
  }
  return {
    template: toSelectedTemplate(resolution.template),
    storedKey,
    fallbackReason: resolution.fallbackReason,
  };
}
