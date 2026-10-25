/**
 * The languages the merchant interface is served in. The backend stores no
 * interface language; it needs the list only to validate content written per
 * interface language (tips and updates). Keep it in step with
 * `akeed-frontend/src/shared/lib/locale.ts` and the `locale` check on
 * `tips_campaign_translations` (drizzle/0077_tips_campaigns.sql).
 *
 * This is not the WhatsApp message language list (`integration_default_language`).
 */
export const INTERFACE_LOCALES = ['ar', 'en', 'ur', 'es', 'fr', 'tr'] as const;
export type InterfaceLocale = (typeof INTERFACE_LOCALES)[number];

/** The locale every piece of per-language content must be complete in. */
export const FALLBACK_INTERFACE_LOCALE: InterfaceLocale = 'en';

export function isInterfaceLocale(value: unknown): value is InterfaceLocale {
  return (
    typeof value === 'string' &&
    (INTERFACE_LOCALES as readonly string[]).includes(value)
  );
}
