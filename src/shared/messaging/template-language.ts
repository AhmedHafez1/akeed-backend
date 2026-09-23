export type TemplateLanguagePreference = 'auto' | 'ar' | 'en';
export type ResolvedTemplateLanguage = 'ar' | 'en';

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

export function isArabicPhoneNumber(phoneNumber: string): boolean {
  const normalizedNumber = phoneNumber.replace(/[^\d+]/g, '');
  const internationalDigits = normalizedNumber.startsWith('+')
    ? normalizedNumber.slice(1)
    : normalizedNumber.startsWith('00')
      ? normalizedNumber.slice(2)
      : normalizedNumber;

  return ARABIC_COUNTRY_CALLING_CODES.some((dialCode) =>
    internationalDigits.startsWith(dialCode),
  );
}

export function resolveTemplateLanguageForPhone(
  preferredLanguage: string | null | undefined,
  phoneNumber: string,
): ResolvedTemplateLanguage {
  if (preferredLanguage === 'ar' || preferredLanguage === 'en') {
    return preferredLanguage;
  }
  return isArabicPhoneNumber(phoneNumber) ? 'ar' : 'en';
}
