import { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import { OrderEligibilityResult } from '../order-eligibility.types';
import type { IntegrationEligibilityInput } from '../order-eligibility.types';

export interface OrderEligibilityStrategy {
  readonly platform: string;
  evaluateOrderForVerification(
    order: NormalizedOrder,
    integration: IntegrationEligibilityInput,
  ): OrderEligibilityResult;
}

export const ORDER_ELIGIBILITY_STRATEGIES = Symbol(
  'ORDER_ELIGIBILITY_STRATEGIES',
);
