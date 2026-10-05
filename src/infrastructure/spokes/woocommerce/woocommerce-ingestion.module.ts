import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { createRestrictedHttp } from '../../../shared/http/restricted-http';
import { PhoneService } from '../../../shared/services/phone.service';
import {
  WooCommerceApiClient,
  WOOCOMMERCE_HTTP,
} from './woocommerce-api.client';
import { WooCommerceConnectionHealthService } from './woocommerce-connection-health.service';
import { WooCommerceOrderEligibilityStrategy } from './woocommerce-order-eligibility.strategy';
import { WooCommerceOrderNormalizer } from './woocommerce-order.normalizer';
import { WooCommerceOrderUpdateHandler } from './woocommerce-order-update.handler';
import { WooCommerceOutcomeAdapter } from './woocommerce-outcome.adapter';
import { WooCommerceSetupContributor } from './woocommerce-setup.contributor';

/**
 * What the workers need from the WooCommerce spoke: the order normalizer and
 * the eligibility strategy (US-07-03), the order-update handler and the
 * outcome adapter (US-07-04), the setup contributor and the connection health
 * service (US-07-05), and the API client on the restricted outbound client
 * that every request to a store goes through. Kept apart from
 * `WooCommerceModule`, which imports the webhook queue for its delivery
 * route, so the queue, the verification core, the outcome registry and
 * onboarding can import this without a cycle.
 */
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    WooCommerceApiClient,
    WooCommerceOrderNormalizer,
    WooCommerceOrderEligibilityStrategy,
    WooCommerceOrderUpdateHandler,
    WooCommerceOutcomeAdapter,
    WooCommerceConnectionHealthService,
    WooCommerceSetupContributor,
    PhoneService,
    { provide: WOOCOMMERCE_HTTP, useFactory: () => createRestrictedHttp() },
  ],
  exports: [
    WooCommerceApiClient,
    WooCommerceOrderNormalizer,
    WooCommerceOrderEligibilityStrategy,
    WooCommerceOrderUpdateHandler,
    WooCommerceOutcomeAdapter,
    WooCommerceConnectionHealthService,
    WooCommerceSetupContributor,
  ],
})
export class WooCommerceIngestionModule {}
