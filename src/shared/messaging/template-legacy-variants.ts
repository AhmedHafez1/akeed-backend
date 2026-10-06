import type { TemplateLanguage } from './template-registry.types';

/**
 * The values the CHECK constraints on the old variant columns allow
 * (migration 0021). Until those columns are dropped after the US-08-08 gate,
 * a write that selects a template sets them together with the registry key,
 * so the previous release can be redeployed and still read the store's
 * choice. A style added later is not in these lists and leaves the old column
 * as it was.
 */
export const LEGACY_VARIANT_COLUMN_VALUES: Record<
  TemplateLanguage,
  readonly string[]
> = {
  ar: ['standard', 'egyptian', 'gulf', 'short'],
  en: ['friendly', 'professional', 'direct', 'short'],
};

export function isLegacyVariant(
  language: TemplateLanguage,
  style: string,
): boolean {
  return LEGACY_VARIANT_COLUMN_VALUES[language].includes(style);
}
