import { NormalizedOrder } from '../../interfaces/order.interface';
import { OrderEligibilityResult } from '../order-eligibility.types';

export interface OrderEligibilityStrategy {
  readonly platform: string;
  evaluateOrderForVerification(order: NormalizedOrder): OrderEligibilityResult;
}
