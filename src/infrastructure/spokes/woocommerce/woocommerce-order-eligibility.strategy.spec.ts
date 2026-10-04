import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import { WooCommerceOrderEligibilityStrategy } from './woocommerce-order-eligibility.strategy';

function order(paymentMethod?: string): NormalizedOrder {
  return {
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: '1001',
    customerPhone: '+201000000000',
    totalPrice: '450.00',
    currency: 'EGP',
    paymentMethod,
  };
}

describe('WooCommerceOrderEligibilityStrategy', () => {
  const strategy = new WooCommerceOrderEligibilityStrategy();

  it('is registered for the woocommerce platform', () => {
    expect(strategy.platform).toBe('woocommerce');
  });

  it.each([
    ['cod', { eligible: true, reason: 'cod_match', matchedSignal: 'cod' }],
    [' cod ', { eligible: true, reason: 'cod_match', matchedSignal: 'cod' }],
    // Only the core gateway ID counts; a custom gateway is out of scope.
    ['COD', { eligible: false, reason: 'non_cod_payment_method' }],
    ['bacs', { eligible: false, reason: 'non_cod_payment_method' }],
    ['cod_custom', { eligible: false, reason: 'non_cod_payment_method' }],
    ['cash on delivery', { eligible: false, reason: 'non_cod_payment_method' }],
    ['', { eligible: false, reason: 'missing_payment_signal' }],
    ['  ', { eligible: false, reason: 'missing_payment_signal' }],
    [undefined, { eligible: false, reason: 'missing_payment_signal' }],
  ])('judges payment method %j', (paymentMethod, expected) => {
    expect(strategy.evaluateOrderForVerification(order(paymentMethod))).toEqual(
      expected,
    );
  });
});
