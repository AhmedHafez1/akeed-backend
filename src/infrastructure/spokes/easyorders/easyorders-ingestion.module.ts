import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { PhoneService } from '../../../shared/services/phone.service';
import { EasyOrdersApiClient, EASYORDERS_HTTP } from './easyorders-api.client';
import { EasyOrdersOrderNormalizer } from './easyorders-order.normalizer';
import { EasyOrdersOutcomeAdapter } from './easyorders-outcome.adapter';
import { EasyOrdersStatusUpdateHandler } from './easyorders-status-update.handler';
import { EasyOrdersRateLimiter } from './easyorders-rate-limiter';

/**
 * What the workers need from the EasyOrders spoke: the order normalizer, the
 * status-event handler, the outcome adapter, and the API client and rate
 * budget they share. Kept apart from `EasyOrdersModule`, which imports the
 * webhook queue for its routes, so the queue and the outcome registry can
 * import this without a cycle. One instance, so one rate budget.
 */
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    EasyOrdersApiClient,
    EasyOrdersRateLimiter,
    EasyOrdersOrderNormalizer,
    EasyOrdersOutcomeAdapter,
    EasyOrdersStatusUpdateHandler,
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
    EasyOrdersOutcomeAdapter,
    EasyOrdersStatusUpdateHandler,
  ],
})
export class EasyOrdersIngestionModule {}
