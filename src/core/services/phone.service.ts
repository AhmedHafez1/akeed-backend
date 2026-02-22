import { Injectable } from '@nestjs/common';
import * as libphonenumber from 'google-libphonenumber';
import { InvalidPhoneNumberError } from '../errors/invalid-phone-number.error';

@Injectable()
export class PhoneService {
  private readonly phoneUtil = libphonenumber.PhoneNumberUtil.getInstance();

  standardize(phone: string, countryCode?: string): string {
    const normalizedPhone = phone?.trim();
    const normalizedCountryCode = countryCode?.trim().toUpperCase();

    if (!normalizedPhone) {
      throw new InvalidPhoneNumberError('Phone number is required.');
    }

    let parsedNumber: libphonenumber.PhoneNumber;
    try {
      parsedNumber = this.phoneUtil.parse(
        normalizedPhone,
        normalizedCountryCode || undefined,
      );
    } catch {
      throw new InvalidPhoneNumberError('Invalid phone number format.');
    }

    if (!this.phoneUtil.isPossibleNumber(parsedNumber)) {
      throw new InvalidPhoneNumberError('Phone number is impossible.');
    }

    if (!this.phoneUtil.isValidNumber(parsedNumber)) {
      throw new InvalidPhoneNumberError('Phone number is invalid.');
    }

    return this.phoneUtil.format(
      parsedNumber,
      libphonenumber.PhoneNumberFormat.E164,
    );
  }
}
