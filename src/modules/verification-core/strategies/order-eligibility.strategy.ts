import { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';
import { OrderEligibilityResult } from '../order-eligibility.types';
import type { IntegrationEligibilityInput } from '../order-eligibility.types';

export interface OrderEligibilityStrategy {
  readonly platform: PlatformType;
  evaluateOrderForVerification(
    order: NormalizedOrder,
    integration: IntegrationEligibilityInput,
  ): OrderEligibilityResult;
}

export const ORDER_ELIGIBILITY_STRATEGIES = Symbol(
  'ORDER_ELIGIBILITY_STRATEGIES',
);
