import {
  intakeBucketStart,
  intakeOrderId,
  normalizeIntakePaymentMethod,
  normalizeIntakeSkipReason,
} from './order-intake.policy';

describe('order intake policy', () => {
  it('keeps a payment-method name as the store gives it, bounded', () => {
    expect(normalizeIntakePaymentMethod('  Cash on   Delivery (COD) ')).toBe(
      'Cash on Delivery (COD)',
    );
    expect(normalizeIntakePaymentMethod('manual')).toBe('manual');
    expect(normalizeIntakePaymentMethod('')).toBe('unknown');
    expect(normalizeIntakePaymentMethod(null)).toBe('unknown');
    expect(normalizeIntakePaymentMethod('x'.repeat(200))).toHaveLength(80);
  });

  it('bounds a skip code', () => {
    expect(normalizeIntakeSkipReason(' non_cod_payment_method ')).toBe(
      'non_cod_payment_method',
    );
    expect(normalizeIntakeSkipReason('   ')).toBe('unknown');
  });

  it('counts an order in its UTC hour', () => {
    expect(
      intakeBucketStart(new Date('2026-11-10T16:59:59.999Z')).toISOString(),
    ).toBe('2026-11-10T16:00:00.000Z');
  });

  it('reads a store order id from a number or a string only', () => {
    expect(intakeOrderId(6123456789)).toBe('6123456789');
    expect(intakeOrderId(' 1001 ')).toBe('1001');
    expect(intakeOrderId('')).toBeNull();
    expect(intakeOrderId({ id: 1 })).toBeNull();
    expect(intakeOrderId(Number.NaN)).toBeNull();
  });
});
