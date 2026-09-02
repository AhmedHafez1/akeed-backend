import { Inject, Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { NormalizedOrder } from '../../shared/interfaces/order.interface';
import {
  IntegrationEligibilityInput,
  OrderEligibilityResult,
} from './order-eligibility.types';
import {
  ORDER_ELIGIBILITY_STRATEGIES,
  type OrderEligibilityStrategy,
} from './strategies/order-eligibility.strategy';

@Injectable()
export class OrderEligibilityService {
  private readonly logger = new Logger(OrderEligibilityService.name);
  private readonly strategyByPlatform: Map<string, OrderEligibilityStrategy>;

  constructor(
    @Inject(ORDER_ELIGIBILITY_STRATEGIES)
    strategies: readonly OrderEligibilityStrategy[],
  ) {
    this.strategyByPlatform = new Map(
      strategies.map((strategy) => [strategy.platform, strategy]),
    );
  }

  evaluateOrderForVerification(params: {
    order: NormalizedOrder;
    integration: IntegrationEligibilityInput;
  }): OrderEligibilityResult {
    const platform = params.integration.platformType;
    const strategy = this.strategyByPlatform.get(platform);
    if (strategy) {
      return strategy.evaluateOrderForVerification(params.order);
    }

    this.logger.warn(
      buildBackendLog('OrderEligibilityService', {
        action: 'evaluateOrderForVerification',
        outcome: 'skipped',
        platform: params.integration.platformType,
        externalOrderId: params.order.externalOrderId,
        reason: 'unsupported_platform',
      }),
    );
    return { eligible: false, reason: 'unsupported_platform' };
  }
}
