export class InvalidPhoneNumberError extends Error {
  constructor(message = 'Invalid or impossible phone number.') {
    super(message);
    this.name = 'InvalidPhoneNumberError';
  }
}
