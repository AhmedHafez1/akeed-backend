import { ShopifyBillingAdapter } from './services/shopify-billing.adapter';
import { ShopifyOrderEligibilityStrategy } from './services/shopify-order-eligibility.strategy';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PhoneService } from '../../../shared/services/phone.service';
import { ShopifyApiService } from './services/shopify-api.service';
import { ShopifyOrderNormalizer } from './services/shopify-order.normalizer';
import { ShopifyOutcomeAdapter } from './services/shopify-outcome.adapter';

/**
 * What the workers and the registries need from the Shopify spoke: the API
 * service, the billing adapter, the outcome adapter, the eligibility strategy
 * and the order normalizer. Kept apart from `ShopifyModule`, which imports
 * the webhook queue for its routes, so the queue and the outcome registry can
 * import this without a cycle.
 */
@Module({
  imports: [HttpModule],
  providers: [
    ShopifyApiService,
    ShopifyBillingAdapter,
    ShopifyOutcomeAdapter,
    ShopifyOrderEligibilityStrategy,
    ShopifyOrderNormalizer,
    PhoneService,
  ],
  exports: [
    ShopifyApiService,
    ShopifyBillingAdapter,
    ShopifyOutcomeAdapter,
    ShopifyOrderEligibilityStrategy,
    ShopifyOrderNormalizer,
  ],
})
export class ShopifyCommerceModule {}
