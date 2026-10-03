import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import { EasyOrdersOrderEligibilityStrategy } from './easyorders-order-eligibility.strategy';

function order(paymentMethod?: string): NormalizedOrder {
  return {
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: 'order-1',
    customerPhone: '+201000000000',
    totalPrice: '750.00',
    currency: 'EGP',
    paymentMethod,
  };
}

describe('EasyOrdersOrderEligibilityStrategy', () => {
  const strategy = new EasyOrdersOrderEligibilityStrategy();

  it('is registered for the easyorders platform', () => {
    expect(strategy.platform).toBe('easyorders');
  });

  it.each([
    ['cod', { eligible: true, reason: 'cod_match', matchedSignal: 'cod' }],
    [' COD ', { eligible: true, reason: 'cod_match', matchedSignal: 'cod' }],
    // The other values are not listed in the contract record yet.
    ['card', { eligible: false, reason: 'non_cod_payment_method' }],
    ['pay on delivery', { eligible: false, reason: 'non_cod_payment_method' }],
    ['', { eligible: false, reason: 'missing_payment_signal' }],
    [undefined, { eligible: false, reason: 'missing_payment_signal' }],
  ])('judges payment method %j', (paymentMethod, expected) => {
    expect(strategy.evaluateOrderForVerification(order(paymentMethod))).toEqual(
      expected,
    );
  });
});
