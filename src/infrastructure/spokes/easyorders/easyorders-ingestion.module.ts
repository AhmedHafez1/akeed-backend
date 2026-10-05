import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { PhoneService } from '../../../shared/services/phone.service';
import { EasyOrdersApiClient, EASYORDERS_HTTP } from './easyorders-api.client';
import { EasyOrdersOrderEligibilityStrategy } from './easyorders-order-eligibility.strategy';
import { EasyOrdersOrderNormalizer } from './easyorders-order.normalizer';
import { EasyOrdersOutcomeAdapter } from './easyorders-outcome.adapter';
import { EasyOrdersStatusUpdateHandler } from './easyorders-status-update.handler';
import { EasyOrdersRateLimiter } from './easyorders-rate-limiter';
import { EasyOrdersSetupContributor } from './easyorders-setup.contributor';

/**
 * What the workers need from the EasyOrders spoke: the order normalizer, the
 * eligibility strategy, the status-event handler, the outcome adapter, the
 * setup contributor that onboarding reads, and the API client and rate budget
 * they share. Kept apart from `EasyOrdersModule`, which imports the webhook
 * queue for its routes, so the queue, the verification core and the outcome
 * registry can import this without a cycle. One instance, so one rate budget.
 */
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    EasyOrdersApiClient,
    EasyOrdersRateLimiter,
    EasyOrdersOrderNormalizer,
    EasyOrdersOrderEligibilityStrategy,
    EasyOrdersOutcomeAdapter,
    EasyOrdersStatusUpdateHandler,
    EasyOrdersSetupContributor,
    PhoneService,
    {
      provide: EASYORDERS_HTTP,
      useValue: (...args: Parameters<typeof fetch>) => fetch(...args),
    },
  ],
  exports: [
    EasyOrdersApiClient,
    EasyOrdersRateLimiter,
    EasyOrdersOrderNormalizer,
    EasyOrdersOrderEligibilityStrategy,
    EasyOrdersOutcomeAdapter,
    EasyOrdersStatusUpdateHandler,
    EasyOrdersSetupContributor,
  ],
})
export class EasyOrdersIngestionModule {}
