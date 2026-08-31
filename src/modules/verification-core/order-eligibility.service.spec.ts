import { OrderEligibilityService } from './order-eligibility.service';
import { NormalizedOrder } from '../../shared/interfaces/order.interface';
import { ShopifyOrderEligibilityStrategy } from './strategies/shopify-order-eligibility.strategy';
import { shopifyPaymentFixtures } from '../webhook-queue/normalizers/fixtures/shopify-order.fixture';

describe('OrderEligibilityService', () => {
  let service: OrderEligibilityService;

  const baseOrder: NormalizedOrder = {
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: '12345',
    customerPhone: '+201000000000',
    totalPrice: '100',
    currency: 'USD',
  };

  beforeEach(() => {
    service = new OrderEligibilityService(
      new ShopifyOrderEligibilityStrategy(),
    );
  });

  it.each([
    'COD',
    'cash_on_delivery',
    'collect-on-delivery',
    'cash on receipt',
    'الدفع عند الاستلام',
    'كاش عند الاستلام',
  ])('accepts normalized paymentMethod %s', (paymentMethod) => {
    expect(
      service.evaluateOrderForVerification({
        order: { ...baseOrder, paymentMethod },
        integration: { platformType: 'shopify' },
      }),
    ).toMatchObject({ eligible: true, reason: 'cod_match' });
  });

  it.each(
    shopifyPaymentFixtures.filter(
      ({ name }) =>
        !['gateway list', 'prepaid', 'missing signals'].includes(name),
    ),
  )('collects payment evidence: $name', ({ payload, eligible }) => {
    expect(
      service.evaluateOrderForVerification({
        order: { ...baseOrder, rawPayload: payload },
        integration: { platformType: 'shopify' },
      }).eligible,
    ).toBe(eligible);
  });

  it('marks Shopify COD orders as eligible from payment_gateway_names', () => {
    const result = service.evaluateOrderForVerification({
      order: {
        ...baseOrder,
        rawPayload: {
          payment_gateway_names: ['Cash on Delivery (COD)'],
        },
      },
      integration: { platformType: 'shopify' },
    });

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('cod_match');
  });

  it('marks Shopify prepaid orders as ineligible', () => {
    const result = service.evaluateOrderForVerification({
      order: {
        ...baseOrder,
        rawPayload: {
          payment_gateway_names: ['Shopify Payments'],
          gateway: 'shopify_payments',
        },
      },
      integration: { platformType: 'shopify' },
    });

    expect(result).toEqual({
      eligible: false,
      reason: 'non_cod_payment_method',
    });
  });

  it('marks Shopify orders with missing payment signal as ineligible', () => {
    const result = service.evaluateOrderForVerification({
      order: { ...baseOrder, rawPayload: {} },
      integration: { platformType: 'shopify' },
    });

    expect(result).toEqual({
      eligible: false,
      reason: 'missing_payment_signal',
    });
  });

  it('skips unsupported platforms', () => {
    const result = service.evaluateOrderForVerification({
      order: baseOrder,
      integration: { platformType: 'woocommerce' },
    });

    expect(result).toEqual({
      eligible: false,
      reason: 'unsupported_platform',
    });
  });
});
