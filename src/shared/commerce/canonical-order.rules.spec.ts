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
  isCanonicalOrderDate,
  validateCanonicalTotalPrice,
} from './canonical-order.rules';
import { CreateApiOrderDto } from '../../modules/order-api/dto/create-api-order.dto';

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

/** Whether the API accepts `field = value`, all else valid. */
function apiAccepts(field: keyof typeof valid, value: string): boolean {
  const dto = plainToInstance(CreateApiOrderDto, {
    ...valid,
    externalOrderId: '1001',
    [field]: value,
  });
  return validateSync(dto).every((error) => error.property !== field);
}

describe('canonical order rules', () => {
  it('is the one currency list, shared with onboarding', () => {
    expect(ONBOARDING_SHIPPING_CURRENCIES).toBe(CANONICAL_ORDER_CURRENCIES);
  });

  describe('parity between CreateManualOrderDto and CreateApiOrderDto', () => {
    it.each<[keyof typeof valid, string]>([
      ['totalPrice', '750'],
      ['totalPrice', '0.01'],
      ['totalPrice', '0'],
      ['totalPrice', '-1'],
      ['totalPrice', '1.999'],
      ['totalPrice', '12345678901'],
      ['totalPrice', '1,000'],
      ['currency', 'egp'],
      ['currency', 'SAR'],
      ['currency', 'XYZ'],
      ['customerName', 'x'.repeat(255)],
      ['customerName', 'x'.repeat(256)],
      ['customerName', '   '],
      ['customerPhone', '123456'],
      ['customerPhone', '1234567'],
      ['customerPhone', '1'.repeat(21)],
      ['orderNumber', 'x'.repeat(100)],
      ['orderNumber', 'x'.repeat(101)],
      ['paymentMethod', 'x'.repeat(100)],
      ['paymentMethod', 'x'.repeat(101)],
      ['paymentMethod', 'Cash_On_Delivery'],
    ])('both judge %s = %j the same way', (field, value) => {
      expect(apiAccepts(field, value)).toBe(manualAccepts(field, value));
    });

    it('both normalize currency and payment method identically', () => {
      const body = {
        ...valid,
        externalOrderId: '1001',
        currency: ' egp ',
        paymentMethod: ' Cash_On-Delivery ',
      };
      const manual = plainToInstance(CreateManualOrderDto, body);
      const api = plainToInstance(CreateApiOrderDto, body);
      expect(api.currency).toBe(manual.currency);
      expect(api.paymentMethod).toBe(manual.paymentMethod);
    });
  });

  describe('isCanonicalOrderDate', () => {
    it.each(['2026-10-02', '2024-02-29', '1999-12-31'])(
      'accepts %s',
      (value) => {
        expect(isCanonicalOrderDate(value)).toBe(true);
      },
    );

    it.each([
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-1-2',
      '02-10-2026',
      '2026/10/02',
      '2026-10-02T10:00:00Z',
      ' 2026-10-02',
      '',
      20261002,
      null,
      undefined,
    ])('rejects %p', (value) => {
      expect(isCanonicalOrderDate(value)).toBe(false);
    });
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
