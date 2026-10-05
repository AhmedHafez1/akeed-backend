/** The languages a template is written in. */
export type TemplateLanguage = 'ar' | 'en';

export const TEMPLATE_LANGUAGES = [
  'ar',
  'en',
] as const satisfies readonly TemplateLanguage[];

/**
 * What a registry template is for. The COD confirmation also serves the
 * reminder and the merchant's test, as it always has.
 */
export type TemplatePurpose = 'cod_confirmation';

export const COD_CONFIRMATION_PURPOSE: TemplatePurpose = 'cod_confirmation';

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
}

export function buildCodConfirmationKey(
  language: TemplateLanguage,
  style: string,
): string {
  return `cod_confirm.${language}.${style}`;
}
