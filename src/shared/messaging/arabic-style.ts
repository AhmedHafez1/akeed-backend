import {
  matchArabicCallingCode,
  type ArabicCallingCode,
} from './template-language';

/** The Arabic styles `auto` chooses between (US-08-07d). */
export type ArabicAutoStyle = 'egyptian' | 'gulf' | 'standard';

/**
 * The one calling-code to style map. Egypt reads Egyptian; Saudi Arabia, the
 * UAE, Bahrain, Qatar, Kuwait and Oman read Gulf; every other Arabic code,
 * and a number with no Arabic code, reads Standard.
 */
const ARABIC_STYLE_BY_CALLING_CODE: Partial<
  Record<ArabicCallingCode, ArabicAutoStyle>
> = {
  '20': 'egyptian',
  '966': 'gulf',
  '971': 'gulf',
  '973': 'gulf',
  '974': 'gulf',
  '965': 'gulf',
  '968': 'gulf',
};

export function arabicStyleForPhone(
  phoneNumber: string | null | undefined,
): ArabicAutoStyle {
  const code = matchArabicCallingCode(phoneNumber ?? '');
  return (code && ARABIC_STYLE_BY_CALLING_CODE[code]) || 'standard';
}
