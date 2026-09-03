import { Injectable } from '@nestjs/common';
import type { IntegrationEligibilityInput } from '../../../../modules/verification-core/order-eligibility.types';
import type { OrderEligibilityResult } from '../../../../modules/verification-core/order-eligibility.types';
import type { OrderEligibilityStrategy } from '../../../../modules/verification-core/strategies/order-eligibility.strategy';
import {
  appendPaymentSignal,
  isCashOnDeliveryPaymentSignal,
  normalizePaymentSignal,
} from '../../../../shared/commerce/payment-signals';
import type { NormalizedOrder } from '../../../../shared/interfaces/order.interface';

@Injectable()
export class StandaloneOrderEligibilityStrategy implements OrderEligibilityStrategy {
  readonly platform = 'standalone';

  evaluateOrderForVerification(
    order: NormalizedOrder,
    integration: IntegrationEligibilityInput,
  ): OrderEligibilityResult {
    if (order.codStatus === 'cod') {
      const matchedSignal = order.paymentSignals
        ?.map(normalizePaymentSignal)
        .find(isCashOnDeliveryPaymentSignal);
      return {
        eligible: true,
        reason: 'cod_match',
        ...(matchedSignal ? { matchedSignal } : {}),
      };
    }

    if (order.codStatus === 'non_cod') {
      return { eligible: false, reason: 'non_cod_payment_method' };
    }

    const signals: string[] = [];
    for (const signal of order.paymentSignals ?? []) {
      appendPaymentSignal(signals, signal);
    }
    appendPaymentSignal(signals, order.paymentMethod);

    const codSignal = signals.find(isCashOnDeliveryPaymentSignal);
    if (codSignal) {
      return {
        eligible: true,
        reason: 'cod_match',
        matchedSignal: codSignal,
      };
    }

    if (signals.length > 0) {
      return { eligible: false, reason: 'non_cod_payment_method' };
    }

    if (integration.assumeCodWhenPaymentMissing === true) {
      return { eligible: true, reason: 'merchant_cod_default' };
    }

    return { eligible: false, reason: 'missing_payment_signal' };
  }
}
