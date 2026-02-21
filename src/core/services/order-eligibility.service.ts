import { Injectable, Logger } from '@nestjs/common';
import { ShopifyOrderEligibilityStrategy } from './order-eligibility/strategies/shopify-order-eligibility.strategy';
import { NormalizedOrder } from '../interfaces/order.interface';
import {
  IntegrationEligibilityInput,
  OrderEligibilityResult,
} from './order-eligibility.types';
import { OrderEligibilityStrategy } from './order-eligibility/order-eligibility.strategy';

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
      `No COD eligibility strategy is configured for platform ${params.integration.platformType}. Skipping order ${params.order.externalOrderId}.`,
    );
    return { eligible: false, reason: 'unsupported_platform' };
  }
}
