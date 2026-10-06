import type {
  TemplateCategory,
  TemplateComponentsSnapshot,
  TemplateReviewStatus,
} from './template-provider.types';

/** The languages a template is written in. */
export type TemplateLanguage = 'ar' | 'en';

export const TEMPLATE_LANGUAGES = [
  'ar',
  'en',
] as const satisfies readonly TemplateLanguage[];

/**
 * What a registry template is for. The COD confirmation is the first send and
 * the merchant's test, and the reminder too unless the store chose a
 * `cod_reminder` template and WHATSAPP_REMINDER_TEMPLATE_ENABLED is on
 * (US-08-07a).
 */
export type TemplatePurpose = 'cod_confirmation' | 'cod_reminder';

export const TEMPLATE_PURPOSES = [
  'cod_confirmation',
  'cod_reminder',
] as const satisfies readonly TemplatePurpose[];

export const COD_CONFIRMATION_PURPOSE: TemplatePurpose = 'cod_confirmation';
export const COD_REMINDER_PURPOSE: TemplatePurpose = 'cod_reminder';

/** The values a send can put in a template. */
export type TemplateVariableKey = 'customer' | 'store' | 'order' | 'total';

export type TemplateParameterFormat = 'named' | 'positional';

/**
 * One variable of a template, in the order the provider receives it. `name`
 * is the provider's parameter name and is present for a named template only.
 */
export interface TemplateVariable {
  key: TemplateVariableKey;
  name?: string;
}

/** The hand-kept preview blocks Settings and the onboarding test render. */
export interface TemplatePreview {
  greeting: string;
  body: string;
  totalLabel: string;
  ending: string;
  confirmButton: string;
  cancelButton: string;
}

/**
 * One registry row in neutral terms. `templateName` and `languageCode` are the
 * provider's own strings, carried as opaque values: only the adapter and the
 * registry repository interpret them.
 */
export interface RegistryTemplate {
  /** Stable identity, for example `cod_confirm.ar.egyptian`. */
  key: string;
  purpose: TemplatePurpose;
  language: TemplateLanguage;
  /** What a merchant chooses, for example `egyptian`. */
  style: string;
  templateName: string;
  languageCode: string;
  parameterFormat: TemplateParameterFormat;
  variables: readonly TemplateVariable[];
  preview: TemplatePreview;
  isActive: boolean;
  isDefault: boolean;
  /**
   * What the last sync or webhook said about the template at the provider.
   * NULL until this environment has synced it.
   */
  reviewStatus: TemplateReviewStatus | null;
  category: TemplateCategory | null;
  /** When a sync last read this template; NULL if it never has. */
  lastSyncedAt: string | null;
  /**
   * The provider's own text as the last sync stored it, opaque outside the
   * adapter. Absent or NULL before a sync. Read only to build previews.
   */
  components?: TemplateComponentsSnapshot | null;
}

export function buildCodConfirmationKey(
  language: TemplateLanguage,
  style: string,
): string {
  return `cod_confirm.${language}.${style}`;
}

/** `cod_reminder.<language>.<style>`, as the US-08-06 flow builds it. */
export function buildCodReminderKey(
  language: TemplateLanguage,
  style: string,
): string {
  return `cod_reminder.${language}.${style}`;
}
