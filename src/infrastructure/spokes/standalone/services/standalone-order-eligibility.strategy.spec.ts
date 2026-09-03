import type { NormalizedOrder } from '../../../../shared/interfaces/order.interface';
import { StandaloneOrderEligibilityStrategy } from './standalone-order-eligibility.strategy';

describe('StandaloneOrderEligibilityStrategy', () => {
  const strategy = new StandaloneOrderEligibilityStrategy();
  const baseOrder: NormalizedOrder = {
    orgId: 'org-1',
    integrationId: 'integration-1',
    externalOrderId: 'order-1',
    customerPhone: '+201000000000',
    totalPrice: '100.00',
    currency: 'EGP',
  };

  it.each(['COD', 'cash_on_delivery', 'الدفع عند الاستلام'])(
    'accepts explicit normalized payment evidence %s',
    (paymentMethod) => {
      expect(
        strategy.evaluateOrderForVerification(
          { ...baseOrder, paymentMethod },
          {
            platformType: 'standalone',
            assumeCodWhenPaymentMissing: false,
          },
        ),
      ).toMatchObject({ eligible: true, reason: 'cod_match' });
    },
  );

  it('honors explicit COD disposition before signals', () => {
    expect(
      strategy.evaluateOrderForVerification(
        { ...baseOrder, codStatus: 'cod' },
        { platformType: 'standalone' },
      ),
    ).toEqual({ eligible: true, reason: 'cod_match' });
    expect(
      strategy.evaluateOrderForVerification(
        { ...baseOrder, codStatus: 'non_cod', paymentSignals: ['cod'] },
        { platformType: 'standalone' },
      ),
    ).toEqual({ eligible: false, reason: 'non_cod_payment_method' });
  });

  it('rejects explicit non-COD evidence', () => {
    expect(
      strategy.evaluateOrderForVerification(
        { ...baseOrder, paymentSignals: ['card'] },
        { platformType: 'standalone' },
      ),
    ).toEqual({ eligible: false, reason: 'non_cod_payment_method' });
  });

  it('requires missing-signal fallback to be explicitly enabled', () => {
    expect(
      strategy.evaluateOrderForVerification(baseOrder, {
        platformType: 'standalone',
        assumeCodWhenPaymentMissing: false,
      }),
    ).toEqual({ eligible: false, reason: 'missing_payment_signal' });
    expect(
      strategy.evaluateOrderForVerification(baseOrder, {
        platformType: 'standalone',
        assumeCodWhenPaymentMissing: true,
      }),
    ).toEqual({ eligible: true, reason: 'merchant_cod_default' });
  });

  it('does not inspect opaque Shopify-shaped raw payloads', () => {
    expect(
      strategy.evaluateOrderForVerification(
        {
          ...baseOrder,
          rawPayload: { payment_gateway_names: ['cod'], gateway: 'cod' },
        },
        { platformType: 'standalone' },
      ),
    ).toEqual({ eligible: false, reason: 'missing_payment_signal' });
  });
});
