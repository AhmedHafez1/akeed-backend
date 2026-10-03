import { Injectable } from '@nestjs/common';
import type { OrderEligibilityResult } from '../../../modules/verification-core/order-eligibility.types';
import type { OrderEligibilityStrategy } from '../../../modules/verification-core/strategies/order-eligibility.strategy';
import type { NormalizedOrder } from '../../../shared/interfaces/order.interface';

/** The one `payment_method` value EasyOrders documents as cash on delivery. */
export const EASYORDERS_COD_PAYMENT_METHOD = 'cod';

/**
 * EasyOrders states the payment method on every order (contract record
 * section 4). Only `cod` is known to mean cash on delivery; the other values
 * are not listed yet, so any of them, and a missing one, is not eligible.
 */
@Injectable()
export class EasyOrdersOrderEligibilityStrategy implements OrderEligibilityStrategy {
  readonly platform = 'easyorders' as const;

  evaluateOrderForVerification(order: NormalizedOrder): OrderEligibilityResult {
    const method = order.paymentMethod?.trim().toLowerCase() ?? '';
    if (method === EASYORDERS_COD_PAYMENT_METHOD)
      return { eligible: true, reason: 'cod_match', matchedSignal: method };
    return {
      eligible: false,
      reason: method ? 'non_cod_payment_method' : 'missing_payment_signal',
    };
  }
}
