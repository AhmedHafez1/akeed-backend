import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateManualOrderDto } from '../../modules/orders/dto/create-manual-order.dto';
import { ONBOARDING_SHIPPING_CURRENCIES } from '../../modules/onboarding/dto/onboarding.dto';
import {
  CANONICAL_ORDER_CURRENCIES,
  fitsCanonicalName,
  fitsCanonicalOrderNumber,
  fitsCanonicalPaymentMethod,
  isCanonicalCurrency,
  validateCanonicalTotalPrice,
} from './canonical-order.rules';

const valid = {
  customerPhone: '+201012345678',
  customerName: 'Ahmed',
  orderNumber: '#1001',
  totalPrice: '750.00',
  currency: 'EGP',
  paymentMethod: 'cash_on_delivery',
};

/** Whether the manual form accepts `field = value`, all else valid. */
function manualAccepts(field: keyof typeof valid, value: string): boolean {
  const dto = plainToInstance(CreateManualOrderDto, {
    ...valid,
    [field]: value,
  });
  return validateSync(dto).every((error) => error.property !== field);
}

describe('canonical order rules', () => {
  it('is the one currency list, shared with onboarding', () => {
    expect(ONBOARDING_SHIPPING_CURRENCIES).toBe(CANONICAL_ORDER_CURRENCIES);
  });

  describe('parity with CreateManualOrderDto', () => {
    it.each([
      '750',
      '750.5',
      '750.50',
      '0.01',
      '9999999999.99',
      '0',
      '0.00',
      '-50',
      '750.555',
      '12345678901',
      '007',
      '1,250',
      '',
      'abc',
    ])('totalPrice %j', (value) => {
      expect(validateCanonicalTotalPrice(value).ok).toBe(
        manualAccepts('totalPrice', value),
      );
    });

    it.each([
      ['customerName', 255, fitsCanonicalName],
      ['customerName', 256, fitsCanonicalName],
      ['orderNumber', 100, fitsCanonicalOrderNumber],
      ['orderNumber', 101, fitsCanonicalOrderNumber],
      ['paymentMethod', 100, fitsCanonicalPaymentMethod],
      ['paymentMethod', 101, fitsCanonicalPaymentMethod],
    ] as const)('%s of %i characters', (field, length, fits) => {
      const value = 'a'.repeat(length);
      expect(fits(value)).toBe(manualAccepts(field, value));
    });

    it.each(['EGP', 'SAR', 'USD', 'XYZ', 'GBP'])('currency %j', (value) => {
      expect(isCanonicalCurrency(value)).toBe(manualAccepts('currency', value));
    });
  });

  it.each([
    ['0', 'not_positive'],
    ['0.00', 'not_positive'],
    ['-50', 'not_positive'],
    ['750.555', 'too_precise'],
    ['12345678901', 'too_large'],
    ['abc', 'malformed'],
    ['007', 'malformed'],
  ])('explains why %j is refused: %s', (value, reason) => {
    expect(validateCanonicalTotalPrice(value)).toEqual({ ok: false, reason });
  });
});
