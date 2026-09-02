import { ShopifyOrderEligibilityStrategy } from './services/shopify-order-eligibility.strategy';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ShopifyApiService } from './services/shopify-api.service';
import { ShopifyOutcomeAdapter } from './services/shopify-outcome.adapter';

@Module({
  imports: [HttpModule],
  providers: [
    ShopifyApiService,
    ShopifyOutcomeAdapter,
    ShopifyOrderEligibilityStrategy,
  ],
  exports: [
    ShopifyApiService,
    ShopifyOutcomeAdapter,
    ShopifyOrderEligibilityStrategy,
  ],
})
export class ShopifyCommerceModule {}
