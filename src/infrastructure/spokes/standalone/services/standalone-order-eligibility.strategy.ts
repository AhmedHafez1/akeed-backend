import { Injectable } from '@nestjs/common';
import {
  collectNormalizedPaymentSignals,
  resolveCodEligibility,
  resolveDeclaredCodStatus,
} from '../../../../modules/verification-core/cod-eligibility';
import type {
  IntegrationEligibilityInput,
  OrderEligibilityResult,
} from '../../../../modules/verification-core/order-eligibility.types';
import type { OrderEligibilityStrategy } from '../../../../modules/verification-core/strategies/order-eligibility.strategy';
import type { NormalizedOrder } from '../../../../shared/interfaces/order.interface';

/**
 * Manually created orders carry exactly the payment method the merchant typed,
 * so there is no extra evidence to dig out. The merchant may opt into treating
 * an unspecified method as cash-on-delivery.
 */
@Injectable()
export class StandaloneOrderEligibilityStrategy implements OrderEligibilityStrategy {
  readonly platform = 'standalone' as const;

  evaluateOrderForVerification(
    order: NormalizedOrder,
    integration: IntegrationEligibilityInput,
  ): OrderEligibilityResult {
    return (
      resolveDeclaredCodStatus(order) ??
      resolveCodEligibility(collectNormalizedPaymentSignals(order), {
        assumeCodWhenPaymentMissing:
          integration.assumeCodWhenPaymentMissing === true,
      })
    );
  }
}
