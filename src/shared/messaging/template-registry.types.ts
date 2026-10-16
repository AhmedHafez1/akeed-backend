import type {
  TemplateCategory,
  TemplateComponentsSnapshot,
  TemplateReviewStatus,
} from './template-provider.types';

/** The languages a template is written in. */
export type TemplateLanguage = 'ar' | 'en' | 'ur' | 'es' | 'fr' | 'tr';

export const TEMPLATE_LANGUAGES = [
  'ar',
  'en',
  'ur',
  'es',
  'fr',
  'tr',
] as const satisfies readonly TemplateLanguage[];

export interface TemplateLanguageDefinition {
  /** The English name, for error messages and staff screens. */
  name: string;
  direction: 'rtl' | 'ltr';
  /**
   * A required language must always have a default template: Settings fails
   * without one. Any other language is simply not offered until staff make a
   * template its default.
   */
  required: boolean;
}

export const TEMPLATE_LANGUAGE_DEFINITIONS = {
  ar: { name: 'Arabic', direction: 'rtl', required: true },
  en: { name: 'English', direction: 'ltr', required: true },
  ur: { name: 'Urdu', direction: 'rtl', required: false },
  es: { name: 'Spanish', direction: 'ltr', required: false },
  fr: { name: 'French', direction: 'ltr', required: false },
  tr: { name: 'Turkish', direction: 'ltr', required: false },
} as const satisfies Record<TemplateLanguage, TemplateLanguageDefinition>;

export function isTemplateLanguage(value: unknown): value is TemplateLanguage {
  return (TEMPLATE_LANGUAGES as readonly unknown[]).includes(value);
}

/**
 * What a registry template is for. The COD confirmation is the first send and
 * the merchant's test, and the reminder too unless the store chose a
 * `cod_reminder` template and WHATSAPP_REMINDER_TEMPLATE_ENABLED is on.
 */
export type TemplatePurpose = 'cod_confirmation' | 'cod_reminder';

export const TEMPLATE_PURPOSES = [
  'cod_confirmation',
  'cod_reminder',
] as const satisfies readonly TemplatePurpose[];

export const COD_CONFIRMATION_PURPOSE: TemplatePurpose = 'cod_confirmation';
export const COD_REMINDER_PURPOSE: TemplatePurpose = 'cod_reminder';

/**
 * The values a send can put in a template. `items`, `region` and `address`
 * are order details: only an order whose source delivered them can fill them.
 */
export type TemplateVariableKey =
  | 'customer'
  | 'store'
  | 'order'
  | 'total'
  | 'items'
  | 'region'
  | 'address';

export type TemplateDetailVariableKey = 'items' | 'region' | 'address';

export const TEMPLATE_DETAIL_VARIABLE_KEYS = [
  'items',
  'region',
  'address',
] as const satisfies readonly TemplateDetailVariableKey[];

export type TemplateParameterFormat = 'named' | 'positional';

/** `image` marks the image-header twin of a text template. */
export type TemplateHeaderFormat = 'none' | 'image';

/**
 * The image-header twin of one text template: the same body, buttons and
 * parameters, sent with the store's banner in place of the text template.
 */
export interface ImageTwinTemplate {
  /** The key of the text template it repeats. */
  imageTwinOfKey: string;
  /** That text template's provider name and language code. */
  twinOf: { templateName: string; languageCode: string };
  templateName: string;
  languageCode: string;
  isActive: boolean;
  reviewStatus: RegistryTemplate['reviewStatus'];
}

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

/** `cod_reminder.<language>.<style>`, as staff authoring builds it. */
export function buildCodReminderKey(
  language: TemplateLanguage,
  style: string,
): string {
  return `cod_reminder.${language}.${style}`;
}
