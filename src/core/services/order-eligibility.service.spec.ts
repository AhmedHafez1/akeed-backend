import { OrderEligibilityService } from './order-eligibility.service';
import { NormalizedOrder } from '../interfaces/order.interface';
import { ShopifyOrderEligibilityStrategy } from './order-eligibility/strategies/shopify-order-eligibility.strategy';

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
