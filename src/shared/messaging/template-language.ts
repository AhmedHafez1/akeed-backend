import {
  isTemplateLanguage,
  type TemplateLanguage,
} from './template-registry.types';

/**
 * `auto` follows the customer's number. `storefront` follows the language the
 * customer shopped in, when the store sends one with the order.
 */
export type TemplateLanguagePreference =
  | 'auto'
  | 'storefront'
  | TemplateLanguage;

export const STOREFRONT_LANGUAGE_PREFERENCE = 'storefront';
export type ResolvedTemplateLanguage = TemplateLanguage;

const ARABIC_COUNTRY_CALLING_CODES = [
  '966', // Saudi Arabia
  '971', // UAE
  '973', // Bahrain
  '974', // Qatar
  '965', // Kuwait
  '968', // Oman
  '20', // Egypt
  '962', // Jordan
  '964', // Iraq
  '963', // Syria
  '961', // Lebanon
  '970', // Palestine
  '212', // Morocco
  '213', // Algeria
  '216', // Tunisia
  '218', // Libya
  '222', // Mauritania
  '249', // Sudan
  '252', // Somalia
  '253', // Djibouti
  '269', // Comoros
  '967', // Yemen
] as const;

export type ArabicCallingCode = (typeof ARABIC_COUNTRY_CALLING_CODES)[number];

function internationalDigitsOf(phoneNumber: string): string {
  const normalizedNumber = phoneNumber.replace(/[^\d+]/g, '');
  return normalizedNumber.startsWith('+')
    ? normalizedNumber.slice(1)
    : normalizedNumber.startsWith('00')
      ? normalizedNumber.slice(2)
      : normalizedNumber;
}

/**
 * The Arabic country calling code a number starts with, or NULL. The one
 * matcher both the language choice and the Arabic style choice read.
 */
export function matchArabicCallingCode(
  phoneNumber: string,
): ArabicCallingCode | null {
  const internationalDigits = internationalDigitsOf(phoneNumber);

  return (
    ARABIC_COUNTRY_CALLING_CODES.find((dialCode) =>
      internationalDigits.startsWith(dialCode),
    ) ?? null
  );
}

export function isArabicPhoneNumber(phoneNumber: string): boolean {
  return matchArabicCallingCode(phoneNumber) !== null;
}

/**
 * The calling codes `auto` reads as Urdu, Spanish, French or Turkish. Only countries
 * where that language is the plain choice are listed: a country with several
 * languages (Canada, Belgium, Switzerland, the United States) and every
 * Arabic country keep the language they always had.
 */
const COUNTRY_LANGUAGE_CALLING_CODES = {
  ur: ['92'], // Pakistan
  es: [
    '34', // Spain
    '51', // Peru
    '52', // Mexico
    '53', // Cuba
    '54', // Argentina
    '56', // Chile
    '57', // Colombia
    '58', // Venezuela
    '502', // Guatemala
    '503', // El Salvador
    '504', // Honduras
    '505', // Nicaragua
    '506', // Costa Rica
    '507', // Panama
    '591', // Bolivia
    '593', // Ecuador
    '595', // Paraguay
    '598', // Uruguay
  ],
  fr: ['33'], // France
  tr: ['90'], // Türkiye
} as const satisfies Partial<Record<TemplateLanguage, readonly string[]>>;

export type CountryTemplateLanguage =
  keyof typeof COUNTRY_LANGUAGE_CALLING_CODES;

/**
 * The Urdu, Spanish, French or Turkish country a number belongs to, or NULL.
 */
export function matchCountryLanguage(
  phoneNumber: string,
): CountryTemplateLanguage | null {
  const digits = internationalDigitsOf(phoneNumber);
  const languages = Object.keys(
    COUNTRY_LANGUAGE_CALLING_CODES,
  ) as CountryTemplateLanguage[];
  return (
    languages.find((language) => {
      const dialCodes: readonly string[] =
        COUNTRY_LANGUAGE_CALLING_CODES[language];
      return dialCodes.some((dialCode) => digits.startsWith(dialCode));
    }) ?? null
  );
}

const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}([-_][a-z0-9]{1,8})*$/;
const LANGUAGE_TAG_MAX_LENGTH = 35;

/**
 * A store's language tag as an order keeps it: trimmed and lower case, or
 * NULL when it is missing or not shaped like a language tag. Matches the
 * `orders_customer_language_check` constraint.
 */
export function normalizeOrderLanguageTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase();
  return tag.length <= LANGUAGE_TAG_MAX_LENGTH && LANGUAGE_TAG_PATTERN.test(tag)
    ? tag
    : null;
}

/**
 * The template language an order's language tag names: the primary subtag
 * (`fr-CA` is French), or NULL when the tag is missing or not a language
 * Akeed writes messages in.
 */
export function templateLanguageOfTag(
  languageTag: string | null | undefined,
): { tag: string; language: TemplateLanguage | null } | null {
  const tag = languageTag?.trim().toLowerCase();
  if (!tag) return null;
  const primary = tag.split(/[-_]/)[0];
  return { tag, language: isTemplateLanguage(primary) ? primary : null };
}

/**
 * The language one message goes out in. A language the store forces wins.
 * `storefront` follows the language the order was placed in: one of Akeed's
 * languages when it can be sent, English for any other language, and the
 * `auto` rule when the order carries no language or its language has no
 * approved template.
 * `auto` follows the number: its country's language when `isLive` says that
 * language can be sent, else Arabic for an Arabic country and English for
 * everyone else. Without `isLive` only Arabic and English are chosen, so a
 * language with no approved template never takes a send away from English.
 */
export function resolveTemplateLanguageForPhone(
  preferredLanguage: string | null | undefined,
  phoneNumber: string,
  isLive?: (language: CountryTemplateLanguage) => boolean,
  orderLanguage?: string | null,
): ResolvedTemplateLanguage {
  if (isTemplateLanguage(preferredLanguage)) return preferredLanguage;
  if (preferredLanguage === STOREFRONT_LANGUAGE_PREFERENCE) {
    const ordered = templateLanguageOfTag(orderLanguage);
    if (ordered && !ordered.language) return 'en';
    const language = ordered?.language;
    if (language === 'ar' || language === 'en') return language;
    if (language && isLive?.(language)) return language;
  }
  const countryLanguage = isLive ? matchCountryLanguage(phoneNumber) : null;
  if (countryLanguage && isLive?.(countryLanguage)) return countryLanguage;
  return isArabicPhoneNumber(phoneNumber) ? 'ar' : 'en';
}
