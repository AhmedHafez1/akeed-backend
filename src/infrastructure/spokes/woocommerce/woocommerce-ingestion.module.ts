import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { createRestrictedHttp } from '../../../shared/http/restricted-http';
import { PhoneService } from '../../../shared/services/phone.service';
import {
  WooCommerceApiClient,
  WOOCOMMERCE_HTTP,
} from './woocommerce-api.client';
import { WooCommerceOrderNormalizer } from './woocommerce-order.normalizer';
import { WooCommerceOrderUpdateHandler } from './woocommerce-order-update.handler';
import { WooCommerceOutcomeAdapter } from './woocommerce-outcome.adapter';

/**
 * What the workers need from the WooCommerce spoke: the order normalizer
 * (US-07-03), the order-update handler and the outcome adapter (US-07-04),
 * and the API client on the restricted outbound client that every request to
 * a store goes through. Kept apart from `WooCommerceModule`, which imports
 * the webhook queue for its delivery route, so the queue and the outcome
 * registry can import this without a cycle.
 */
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    WooCommerceApiClient,
    WooCommerceOrderNormalizer,
    WooCommerceOrderUpdateHandler,
    WooCommerceOutcomeAdapter,
    PhoneService,
    { provide: WOOCOMMERCE_HTTP, useFactory: () => createRestrictedHttp() },
  ],
  exports: [
    WooCommerceApiClient,
    WooCommerceOrderNormalizer,
    WooCommerceOrderUpdateHandler,
    WooCommerceOutcomeAdapter,
  ],
})
export class WooCommerceIngestionModule {}
