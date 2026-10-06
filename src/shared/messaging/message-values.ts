import type { TemplateLanguage } from './template-registry.types';

/**
 * The currency word Arabic readers expect after an amount. A currency not
 * listed here is written with its ISO code (US-08-07f).
 */
const ARABIC_CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  EGP: 'ج.م',
  SAR: 'ر.س',
  AED: 'د.إ',
  KWD: 'د.ك',
  QAR: 'ر.ق',
  BHD: 'د.ب',
  OMR: 'ر.ع',
  USD: '$',
};

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

/** The total as it was always sent: the stored number, a space, the code. */
export function legacyOrderTotal(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): string {
  return `${amount} ${currency ?? ''}`.trim();
}

/**
 * Digits after the decimal point for an ISO currency (KWD, BHD, OMR: 3).
 * A code that is not well formed reads as 2.
 */
export function currencyMinorUnits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The fraction padded to the currency's minor units. Zeros past the minor
 * units are dropped; any other digit is kept, so nothing is ever rounded.
 */
function fractionFor(fraction: string, minorUnits: number): string {
  let digits = fraction;
  while (digits.length > minorUnits && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
  }
  return digits.padEnd(minorUnits, '0');
}

/**
 * The `total` value written per language and currency (US-08-07f):
 * `1,250.00 ج.م` in Arabic, `EGP 1,250.00` in English, Western digits, the
 * currency's minor units always shown. It works on the stored decimal
 * string and never rounds, so the amount cannot change. A missing currency
 * sends the number alone; a value that is not a plain decimal is sent as it
 * always was.
 */
export function formatOrderTotal(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
  language: TemplateLanguage,
): string {
  const match =
    amount === null || amount === undefined
      ? null
      : PLAIN_DECIMAL.exec(String(amount).trim());
  const code = (currency ?? '').trim().toUpperCase();
  if (!match || (code && !ISO_CURRENCY.test(code))) {
    return legacyOrderTotal(amount, currency);
  }
  const [, whole, fraction = ''] = match;
  const minorUnits = code ? currencyMinorUnits(code) : 2;
  const decimals = fractionFor(fraction, minorUnits);
  const number = `${groupThousands(whole.replace(/^0+(?=\d)/, ''))}${
    decimals ? `.${decimals}` : ''
  }`;
  if (!code) return number;
  if (language === 'ar') {
    return `${number} ${ARABIC_CURRENCY_SYMBOLS[code] ?? code}`;
  }
  return `${code} ${number}`;
}
