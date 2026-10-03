import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { PhoneService } from '../../../shared/services/phone.service';
import { EasyOrdersApiClient, EASYORDERS_HTTP } from './easyorders-api.client';
import { EasyOrdersOrderNormalizer } from './easyorders-order.normalizer';
import { EasyOrdersRateLimiter } from './easyorders-rate-limiter';

/**
 * What the webhook worker needs from the EasyOrders spoke: the normalizer and
 * the API client and rate budget it reads orders with. Kept apart from
 * `EasyOrdersModule`, which imports the webhook queue for its routes, so the
 * queue can import this without a cycle. One instance, so one rate budget.
 */
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    EasyOrdersApiClient,
    EasyOrdersRateLimiter,
    EasyOrdersOrderNormalizer,
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
  ],
})
export class EasyOrdersIngestionModule {}
