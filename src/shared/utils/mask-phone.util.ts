const MASK = '•';
const MIN_MASKABLE_DIGITS = 8;
const VISIBLE_SUFFIX_DIGITS = 3;

export function maskPhone(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return '';
  const prefix = raw.startsWith('+') ? '+' : '';
  if (digits.length < MIN_MASKABLE_DIGITS) {
    return `${prefix}${MASK.repeat(digits.length)}`;
  }
  const visiblePrefixDigits = digits.length >= 11 ? 4 : 2;
  const hidden = digits.length - visiblePrefixDigits - VISIBLE_SUFFIX_DIGITS;
  return `${prefix}${digits.slice(0, visiblePrefixDigits)}${MASK.repeat(hidden)}${digits.slice(-VISIBLE_SUFFIX_DIGITS)}`;
}
