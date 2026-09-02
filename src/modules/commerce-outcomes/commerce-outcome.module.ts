import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { COMMERCE_OUTCOME_ADAPTERS } from '../../shared/commerce/commerce-outcome';
import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import { ShopifyCommerceModule } from '../../infrastructure/spokes/shopify/shopify-commerce.module';
import { ShopifyOutcomeAdapter } from '../../infrastructure/spokes/shopify/services/shopify-outcome.adapter';

@Global()
@Module({
  imports: [DatabaseModule, ShopifyCommerceModule],
  providers: [
    {
      provide: COMMERCE_OUTCOME_ADAPTERS,
      inject: [ShopifyOutcomeAdapter],
      useFactory: (shopify: ShopifyOutcomeAdapter) => [shopify],
    },
    CommerceOutcomeRegistryService,
  ],
  exports: [COMMERCE_OUTCOME_ADAPTERS, CommerceOutcomeRegistryService],
})
export class CommerceOutcomeModule {}
