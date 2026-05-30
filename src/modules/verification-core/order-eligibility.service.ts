import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { ShopifyOrderEligibilityStrategy } from './strategies/shopify-order-eligibility.strategy';
import { NormalizedOrder } from '../../shared/interfaces/order.interface';
import {
  IntegrationEligibilityInput,
  OrderEligibilityResult,
} from './order-eligibility.types';
import { OrderEligibilityStrategy } from './strategies/order-eligibility.strategy';

@Injectable()
export class OrderEligibilityService {
  private readonly logger = new Logger(OrderEligibilityService.name);
  private readonly strategyByPlatform: Map<string, OrderEligibilityStrategy>;

  constructor(
    private readonly shopifyStrategy: ShopifyOrderEligibilityStrategy,
  ) {
    this.strategyByPlatform = new Map<string, OrderEligibilityStrategy>([
      [this.shopifyStrategy.platform, this.shopifyStrategy],
    ]);
  }

  evaluateOrderForVerification(params: {
    order: NormalizedOrder;
    integration: IntegrationEligibilityInput;
  }): OrderEligibilityResult {
    const platform = params.integration.platformType.trim().toLowerCase();
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
