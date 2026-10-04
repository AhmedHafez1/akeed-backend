import { Injectable } from '@nestjs/common';
import type { OrderEligibilityResult } from '../../../modules/verification-core/order-eligibility.types';
import type { OrderEligibilityStrategy } from '../../../modules/verification-core/strategies/order-eligibility.strategy';
import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import {
  isWooCommerceCashOnDelivery,
  WOOCOMMERCE_COD_PAYMENT_METHOD,
} from './woocommerce-ingestion.policy';

/**
 * WooCommerce states the payment gateway on every order (contract record
 * section 4). Only the core gateway `cod` is cash on delivery; a custom
 * gateway, and a missing one, is not eligible. The ingestion policy already
 * applied the same test, and it is repeated here so the core never falls back
 * to another platform's rule.
 */
@Injectable()
export class WooCommerceOrderEligibilityStrategy implements OrderEligibilityStrategy {
  readonly platform = 'woocommerce' as const;

  evaluateOrderForVerification(order: NormalizedOrder): OrderEligibilityResult {
    if (isWooCommerceCashOnDelivery(order.paymentMethod))
      return {
        eligible: true,
        reason: 'cod_match',
        matchedSignal: WOOCOMMERCE_COD_PAYMENT_METHOD,
      };
    return {
      eligible: false,
      reason: order.paymentMethod?.trim()
        ? 'non_cod_payment_method'
        : 'missing_payment_signal',
    };
  }
}
