import { InvalidPhoneNumberError } from '../errors/invalid-phone-number.error';
import { PhoneService } from './phone.service';

describe('PhoneService', () => {
  const phones = new PhoneService();

  describe('standardize (existing callers)', () => {
    it.each([
      ['+201012345678', undefined, '+201012345678'],
      ['01012345678', 'eg', '+201012345678'],
      [' 0501234567 ', 'SA', '+966501234567'],
      ['0223456789', 'EG', '+20223456789'],
    ])('formats %j (%s) as %s', (phone, country, expected) => {
      expect(phones.standardize(phone, country)).toBe(expected);
    });

    it.each([
      ['  ', 'EG', 'Phone number is required.'],
      ['not a phone', 'EG', 'Invalid phone number format.'],
      ['01012345678', undefined, 'Invalid phone number format.'],
      ['0101234567890123', 'EG', 'Phone number is impossible.'],
      ['010123', 'EG', 'Phone number is invalid.'],
    ])('throws for %j (%s) with %j', (phone, country, message) => {
      expect(() => phones.standardize(phone, country)).toThrow(
        new InvalidPhoneNumberError(message),
      );
    });
  });

  describe('standardizeMobile', () => {
    it.each([
      ['00201012345678', 'EG', '+201012345678'],
      ['1012345678', 'EG', '+201012345678'],
      ['010-1234-5678', 'EG', '+201012345678'],
      ['+966501234567', 'EG', '+966501234567'],
      ['0501234567', 'SA', '+966501234567'],
    ])('accepts %j in %s as %s', (phone, country, e164) => {
      expect(phones.standardizeMobile(phone, country)).toEqual({
        ok: true,
        e164,
      });
    });

    it.each([
      ['2.01012E+11', 'PHONE_SCIENTIFIC_NOTATION'],
      ['0223456789', 'PHONE_NOT_MOBILE'],
      ['010123', 'PHONE_INVALID'],
      ['', 'PHONE_INVALID'],
    ])('refuses %j with %s', (phone, code) => {
      expect(phones.standardizeMobile(phone, 'EG')).toEqual({
        ok: false,
        code,
      });
    });

    it('adds the lost leading zero for Egypt only', () => {
      expect(phones.standardizeMobile('1012345678', 'SA')).toEqual({
        ok: false,
        code: 'PHONE_INVALID',
      });
    });
  });
});
