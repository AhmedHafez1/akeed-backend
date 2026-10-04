import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { COMMERCE_OUTCOME_ADAPTERS } from '../../shared/commerce/commerce-outcome';
import { CommerceOutcomeRegistryService } from './commerce-outcome-registry.service';
import { ShopifyCommerceModule } from '../../infrastructure/spokes/shopify/shopify-commerce.module';
import { ShopifyOutcomeAdapter } from '../../infrastructure/spokes/shopify/services/shopify-outcome.adapter';
import { StandaloneOutcomeAdapter } from '../../infrastructure/spokes/standalone/services/standalone-outcome.adapter';
import { EasyOrdersIngestionModule } from '../../infrastructure/spokes/easyorders/easyorders-ingestion.module';
import { EasyOrdersOutcomeAdapter } from '../../infrastructure/spokes/easyorders/easyorders-outcome.adapter';
import { WooCommerceIngestionModule } from '../../infrastructure/spokes/woocommerce/woocommerce-ingestion.module';
import { WooCommerceOutcomeAdapter } from '../../infrastructure/spokes/woocommerce/woocommerce-outcome.adapter';

@Global()
@Module({
  imports: [
    DatabaseModule,
    ShopifyCommerceModule,
    EasyOrdersIngestionModule,
    WooCommerceIngestionModule,
  ],
  providers: [
    StandaloneOutcomeAdapter,
    {
      provide: COMMERCE_OUTCOME_ADAPTERS,
      inject: [
        ShopifyOutcomeAdapter,
        StandaloneOutcomeAdapter,
        EasyOrdersOutcomeAdapter,
        WooCommerceOutcomeAdapter,
      ],
      useFactory: (
        shopify: ShopifyOutcomeAdapter,
        standalone: StandaloneOutcomeAdapter,
        easyOrders: EasyOrdersOutcomeAdapter,
        wooCommerce: WooCommerceOutcomeAdapter,
      ) => [shopify, standalone, easyOrders, wooCommerce],
    },
    CommerceOutcomeRegistryService,
  ],
  exports: [COMMERCE_OUTCOME_ADAPTERS, CommerceOutcomeRegistryService],
})
export class CommerceOutcomeModule {}
