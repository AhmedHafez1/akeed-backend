import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { COMMERCE_OUTCOME_ADAPTERS } from '../../shared/commerce/commerce-outcome';
import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import { ShopifyCommerceModule } from '../../infrastructure/spokes/shopify/shopify-commerce.module';
import { ShopifyOutcomeAdapter } from '../../infrastructure/spokes/shopify/services/shopify-outcome.adapter';
import { StandaloneOutcomeAdapter } from '../../infrastructure/spokes/standalone/services/standalone-outcome.adapter';

@Global()
@Module({
  imports: [DatabaseModule, ShopifyCommerceModule],
  providers: [
    StandaloneOutcomeAdapter,
    {
      provide: COMMERCE_OUTCOME_ADAPTERS,
      inject: [ShopifyOutcomeAdapter, StandaloneOutcomeAdapter],
      useFactory: (
        shopify: ShopifyOutcomeAdapter,
        standalone: StandaloneOutcomeAdapter,
      ) => [shopify, standalone],
    },
    CommerceOutcomeRegistryService,
  ],
  exports: [COMMERCE_OUTCOME_ADAPTERS, CommerceOutcomeRegistryService],
})
export class CommerceOutcomeModule {}
