import { arabicStyleForPhone } from './arabic-style';
import type { SelectedCodTemplate } from './cod-template-selector';
import { resolveTemplateLanguageForPhone } from './template-language';
import { isSendableReviewStatus } from './template-provider.types';
import {
  COD_CONFIRMATION_PURPOSE,
  COD_REMINDER_PURPOSE,
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
  | 'wrong_language'
  /** The guardrail is on and the provider has not approved the template. */
  | 'not_approved'
  /**
   * The store's reminder and the language's reminder default could not be
   * sent, so the reminder carried the first-send template (US-08-07a).
   */
  | 'reminder_unavailable'
  /**
   * The style `auto` mapped the number to could not be sent, so the Arabic
   * default was (US-08-07d).
   */
  | 'auto_style_unavailable';

/**
 * Whether a send may use only templates the provider has approved. It applies
 * once this environment has synced at least once: before that no row says
 * anything about the provider, and sends behave as they did before the
 * guardrail existed (US-08-04 open decision 3).
 */
export interface TemplateSendGuardrail {
  enabled: boolean;
}

/** True once a sync has read the provider's templates in this environment. */
export function hasSyncedRegistry(
  templates: readonly RegistryTemplate[],
): boolean {
  return templates.some((template) => template.lastSyncedAt !== null);
}

function guardrailApplies(
  templates: readonly RegistryTemplate[],
  guardrail: TemplateSendGuardrail | undefined,
): boolean {
  return guardrail?.enabled === true && hasSyncedRegistry(templates);
}

/**
 * Whether a template may be sent: active in Akeed and, when the guardrail
 * applies, approved by the provider. A category the provider changed does not
 * make it unsendable; that is a staff alert only (US-08-04 open decision 5).
 */
export function isSendableTemplate(
  template: RegistryTemplate,
  guardrailOn: boolean,
): boolean {
  if (!template.isActive) return false;
  return !guardrailOn || isSendableReviewStatus(template.reviewStatus);
}

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
  purpose: TemplatePurpose = COD_CONFIRMATION_PURPOSE,
): RegistryTemplate | undefined {
  return selectableTemplates(templates, language, purpose).find(
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

function findSendableDefault(
  templates: readonly RegistryTemplate[],
  language: TemplateLanguage,
  purpose: TemplatePurpose,
  guardrailOn: boolean,
): RegistryTemplate | undefined {
  const fallback = findDefaultTemplate(templates, language, purpose);
  return fallback && isSendableTemplate(fallback, guardrailOn)
    ? fallback
    : undefined;
}

/**
 * Resolves a stored choice to a template that may be sent. A choice that is
 * missing, unknown, inactive, written for another language or, under the
 * guardrail, not approved by the provider falls back to the language default
 * and says why. The default must pass the same test. With no sendable default
 * there is nothing to send: the caller skips, it never picks another template
 * and never crosses to the other language.
 */
export function resolveTemplate(
  templates: readonly RegistryTemplate[],
  params: {
    language: TemplateLanguage;
    storedKey: string | null;
    purpose?: TemplatePurpose;
    guardrail?: TemplateSendGuardrail;
  },
): TemplateResolution {
  const purpose = params.purpose ?? COD_CONFIRMATION_PURPOSE;
  const guardrailOn = guardrailApplies(templates, params.guardrail);
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
  } else if (!isSendableTemplate(stored, guardrailOn)) {
    fallbackReason = 'not_approved';
  } else {
    return { template: stored };
  }

  const fallback = findSendableDefault(
    templates,
    params.language,
    purpose,
    guardrailOn,
  );
  return fallback
    ? { template: fallback, fallbackReason }
    : { template: null, reason: 'default_unavailable' };
}

/**
 * The sendable template of a style: the style itself, else its newest
 * staff-written version (`<style>_v<n>`). US-08-06 names authored styles that
 * way, so `egyptian` also finds `egyptian_v2`.
 */
export function findSendableByStyle(
  templates: readonly RegistryTemplate[],
  params: {
    language: TemplateLanguage;
    purpose: TemplatePurpose;
    style: string;
    guardrail?: TemplateSendGuardrail;
  },
): RegistryTemplate | undefined {
  const guardrailOn = guardrailApplies(templates, params.guardrail);
  const sendable = selectableTemplates(
    templates,
    params.language,
    params.purpose,
  ).filter((template) => isSendableTemplate(template, guardrailOn));
  const exact = sendable.find((template) => template.style === params.style);
  if (exact) return exact;
  const versioned = new RegExp(`^${params.style}_v(\\d+)$`);
  return sendable
    .map((template) => ({
      template,
      version: Number(versioned.exec(template.style)?.[1] ?? NaN),
    }))
    .filter(({ version }) => Number.isInteger(version))
    .sort((left, right) => right.version - left.version)[0]?.template;
}

/**
 * The switches of US-08-07 the selector reads. Absent means off, which is how
 * every send was selected before.
 */
export interface TemplateSelectionSwitches {
  reminderTemplate?: boolean;
  arabicStyleAuto?: boolean;
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
    guardrail?: TemplateSendGuardrail;
    /** `follow_up` is the reminder. Absent reads as the first send. */
    kind?: 'initial' | 'follow_up';
    arReminderKey?: string | null;
    enReminderKey?: string | null;
    /** The store chose `auto` as its Arabic style. */
    arAuto?: boolean;
    switches?: TemplateSelectionSwitches;
  },
): TemplateSelection {
  const language = resolveTemplateLanguageForPhone(
    params.preferredLanguage,
    params.phoneNumber ?? '',
  );
  const autoStyle =
    language === 'ar' &&
    params.arAuto === true &&
    params.switches?.arabicStyleAuto === true
      ? arabicStyleForPhone(params.phoneNumber)
      : null;

  const firstSend = autoStyle
    ? resolveAutoStyle(templates, {
        style: autoStyle,
        guardrail: params.guardrail,
      })
    : resolveStoredFirstSend(templates, language, params);
  if (!firstSend.template) return firstSend;

  if (params.kind !== 'follow_up' || params.switches?.reminderTemplate !== true)
    return firstSend;
  const reminderKey =
    language === 'ar' ? params.arReminderKey : params.enReminderKey;
  // No reminder chosen: the reminder is the first-send template, as before.
  if (!reminderKey) return firstSend;

  const reminder = autoStyle
    ? resolveAutoReminder(templates, {
        style: autoStyle,
        storedKey: reminderKey,
        guardrail: params.guardrail,
      })
    : resolveTemplate(templates, {
        language,
        storedKey: reminderKey,
        purpose: COD_REMINDER_PURPOSE,
        guardrail: params.guardrail,
      });
  if (reminder.template) {
    return {
      template: toSelectedTemplate(reminder.template),
      storedKey: reminderKey,
      fallbackReason: reminder.fallbackReason,
    };
  }
  return {
    template: firstSend.template,
    storedKey: reminderKey,
    fallbackReason: 'reminder_unavailable',
  };
}

function resolveStoredFirstSend(
  templates: readonly RegistryTemplate[],
  language: TemplateLanguage,
  params: {
    arKey?: string | null;
    enKey?: string | null;
    arLegacyVariant?: string | null;
    enLegacyVariant?: string | null;
    guardrail?: TemplateSendGuardrail;
  },
): TemplateSelection {
  const storedKey = storedTemplateKey(
    language === 'ar'
      ? { language, key: params.arKey, legacyVariant: params.arLegacyVariant }
      : { language, key: params.enKey, legacyVariant: params.enLegacyVariant },
  );
  const resolution = resolveTemplate(templates, {
    language,
    storedKey,
    guardrail: params.guardrail,
  });
  if (!resolution.template) {
    return { template: null, language, storedKey, reason: resolution.reason };
  }
  return {
    template: toSelectedTemplate(resolution.template),
    storedKey,
    fallbackReason: resolution.fallbackReason,
  };
}

/**
 * `auto`: the Arabic template of the style the number maps to, else the
 * Arabic default with `auto_style_unavailable`. The key `auto` stood for is
 * recorded as the one passed over.
 */
function resolveAutoStyle(
  templates: readonly RegistryTemplate[],
  params: { style: string; guardrail?: TemplateSendGuardrail },
): TemplateSelection {
  const storedKey = buildCodConfirmationKey('ar', params.style);
  const mapped = findSendableByStyle(templates, {
    language: 'ar',
    purpose: COD_CONFIRMATION_PURPOSE,
    style: params.style,
    guardrail: params.guardrail,
  });
  if (mapped) return { template: toSelectedTemplate(mapped), storedKey };
  const fallback = findSendableDefault(
    templates,
    'ar',
    COD_CONFIRMATION_PURPOSE,
    guardrailApplies(templates, params.guardrail),
  );
  return fallback
    ? {
        template: toSelectedTemplate(fallback),
        storedKey,
        fallbackReason: 'auto_style_unavailable',
      }
    : {
        template: null,
        language: 'ar',
        storedKey,
        reason: 'default_unavailable',
      };
}

/**
 * A store on `auto` that chose a reminder gets the reminder of the mapped
 * style, else the Arabic reminder default with `auto_style_unavailable`.
 */
function resolveAutoReminder(
  templates: readonly RegistryTemplate[],
  params: {
    style: string;
    storedKey: string;
    guardrail?: TemplateSendGuardrail;
  },
): TemplateResolution {
  const mapped = findSendableByStyle(templates, {
    language: 'ar',
    purpose: COD_REMINDER_PURPOSE,
    style: params.style,
    guardrail: params.guardrail,
  });
  if (mapped) return { template: mapped };
  const fallback = findSendableDefault(
    templates,
    'ar',
    COD_REMINDER_PURPOSE,
    guardrailApplies(templates, params.guardrail),
  );
  return fallback
    ? { template: fallback, fallbackReason: 'auto_style_unavailable' }
    : { template: null, reason: 'default_unavailable' };
}
