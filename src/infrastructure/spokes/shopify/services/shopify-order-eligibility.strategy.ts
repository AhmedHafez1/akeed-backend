import { Injectable } from '@nestjs/common';
import {
  collectNormalizedPaymentSignals,
  resolveCodEligibility,
  resolveDeclaredCodStatus,
} from '../../../../modules/verification-core/cod-eligibility';
import type { OrderEligibilityResult } from '../../../../modules/verification-core/order-eligibility.types';
import type { OrderEligibilityStrategy } from '../../../../modules/verification-core/strategies/order-eligibility.strategy';
import { appendPaymentSignal } from '../../../../shared/commerce/payment-signals';
import type { NormalizedOrder } from '../../../../shared/interfaces/order.interface';
import { collectShopifyGatewaySignals } from './shopify-payment-signals';

/**
 * Shopify reports payment through gateways and transactions on the raw order
 * payload, so eligibility re-reads them rather than trusting only the
 * normalized `paymentSignals` — orders persisted before signal collection
 * existed still carry the evidence in their raw payload.
 *
 * `assumeCodWhenPaymentMissing` is deliberately not honoured here: a Shopify
 * order always reports a gateway, so an absent signal means the payload was
 * unreadable, not that the order is cash-on-delivery.
 */
@Injectable()
export class ShopifyOrderEligibilityStrategy implements OrderEligibilityStrategy {
  readonly platform = 'shopify' as const;

  evaluateOrderForVerification(order: NormalizedOrder): OrderEligibilityResult {
    const declared = resolveDeclaredCodStatus(order);
    if (declared) return declared;

    const signals = collectNormalizedPaymentSignals(order);
    for (const signal of collectShopifyGatewaySignals(order.rawPayload)) {
      appendPaymentSignal(signals, signal);
    }
    return resolveCodEligibility(signals);
  }
}
