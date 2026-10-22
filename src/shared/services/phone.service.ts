import { Injectable } from '@nestjs/common';
import * as libphonenumber from 'google-libphonenumber';
import { InvalidPhoneNumberError } from '../errors/invalid-phone-number.error';

export type PhoneParseFailure =
  | 'empty'
  | 'unparseable'
  | 'impossible'
  | 'invalid';

export type PhoneParseResult =
  | {
      ok: true;
      e164: string;
      type: libphonenumber.PhoneNumberType;
    }
  | { ok: false; reason: PhoneParseFailure };

export type MobilePhoneFailureCode =
  | 'PHONE_INVALID'
  | 'PHONE_NOT_MOBILE'
  | 'PHONE_SCIENTIFIC_NOTATION';

export type MobilePhoneResult =
  | { ok: true; e164: string }
  | { ok: false; code: MobilePhoneFailureCode };

const PARSE_FAILURE_MESSAGES: Record<PhoneParseFailure, string> = {
  empty: 'Phone number is required.',
  unparseable: 'Invalid phone number format.',
  impossible: 'Phone number is impossible.',
  invalid: 'Phone number is invalid.',
};

/** `2.01012E+11`: Excel turned the number into a float and dropped digits. */
const SCIENTIFIC_NOTATION = /^\d+(?:\.\d+)?e\+?\d+$/i;
const PHONE_PUNCTUATION = /[\s\-.()/]+/g;
/** An Egyptian mobile whose leading zero Excel removed: `1012345678`. */
const EG_MOBILE_WITHOUT_ZERO = /^1\d{9}$/;

const phoneUtil = libphonenumber.PhoneNumberUtil.getInstance();
const REGION_CODE = /^[A-Z]{2}$/;

/**
 * The country a stored E.164 phone belongs to (`GT` for `+502…`), or null.
 *
 * Shared calling codes (`+1`, `+7`, `+44`) are resolved by number range. It
 * says where the number is registered, not where the customer lives.
 * Non-geographic codes (`001`) and unparseable values give null. A plain
 * function so the orders repositories and the backfill script can use it.
 */
export function phoneRegion(phone: string | null | undefined): string | null {
  const raw = (phone ?? '').trim();
  if (!raw.startsWith('+')) return null;
  try {
    const region = phoneUtil.getRegionCodeForNumber(phoneUtil.parse(raw));
    return region && REGION_CODE.test(region) ? region : null;
  } catch {
    return null;
  }
}

@Injectable()
export class PhoneService {
  private readonly phoneUtil = phoneUtil;

  /** The one libphonenumber path every phone rule in the app goes through. */
  parse(phone: string, countryCode?: string): PhoneParseResult {
    const normalizedPhone = phone.trim();
    const normalizedCountryCode = countryCode?.trim()?.toUpperCase();

    if (!normalizedPhone) return { ok: false, reason: 'empty' };

    let parsedNumber: libphonenumber.PhoneNumber;
    try {
      parsedNumber = this.phoneUtil.parse(
        normalizedPhone,
        normalizedCountryCode,
      );
    } catch {
      return { ok: false, reason: 'unparseable' };
    }

    if (!this.phoneUtil.isPossibleNumber(parsedNumber))
      return { ok: false, reason: 'impossible' };

    if (!this.phoneUtil.isValidNumber(parsedNumber))
      return { ok: false, reason: 'invalid' };

    return {
      ok: true,
      e164: this.phoneUtil.format(
        parsedNumber,
        libphonenumber.PhoneNumberFormat.E164,
      ),
      type: this.phoneUtil.getNumberType(parsedNumber),
    };
  }

  standardize(phone: string, countryCode?: string): string {
    const result = this.parse(phone, countryCode);
    if (!result.ok)
      throw new InvalidPhoneNumberError(PARSE_FAILURE_MESSAGES[result.reason]);
    return result.e164;
  }

  /** A country's calling code (`966` for `SA`), or null when it is unknown. */
  callingCode(countryCode: string): number | null {
    const code = this.phoneUtil.getCountryCodeForRegion(
      countryCode.trim().toUpperCase(),
    );
    return code > 0 ? code : null;
  }

  /**
   * A customer's WhatsApp-capable number from spreadsheet text.
   *
   * `00` means `+`; a value starting with `+` keeps its own country, anything
   * else is read in `countryCode`. Landlines are rejected: they cannot receive
   * the confirmation message.
   */
  standardizeMobile(phone: string, countryCode: string): MobilePhoneResult {
    const trimmed = phone.trim();
    if (SCIENTIFIC_NOTATION.test(trimmed))
      return { ok: false, code: 'PHONE_SCIENTIFIC_NOTATION' };

    let candidate = trimmed.replace(PHONE_PUNCTUATION, '');
    if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
    const region = countryCode.trim().toUpperCase();
    if (region === 'EG' && EG_MOBILE_WITHOUT_ZERO.test(candidate))
      candidate = `0${candidate}`;

    const result = this.parse(candidate, region);
    if (!result.ok) return { ok: false, code: 'PHONE_INVALID' };
    if (
      result.type !== libphonenumber.PhoneNumberType.MOBILE &&
      result.type !== libphonenumber.PhoneNumberType.FIXED_LINE_OR_MOBILE
    )
      return { ok: false, code: 'PHONE_NOT_MOBILE' };
    return { ok: true, e164: result.e164 };
  }
}
