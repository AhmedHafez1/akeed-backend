import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { PhoneService } from '../../shared/services/phone.service';
import { IntegrationKeysModule } from '../integration-keys/integration-keys.module';
import { OrderIngestionModule } from '../order-ingestion/order-ingestion.module';
import { ApiOrderChannelAdapter } from './api-order.channel-adapter';
import { OrderApiExceptionFilter } from './edge/order-api-exception.filter';
import { OrderApiOutcomeInterceptor } from './edge/order-api-outcome.interceptor';
import {
  OrderApiIngressThrottleGuard,
  OrderApiThrottleGuard,
} from './edge/order-api-throttle.guard';
import { OrderApiController } from './order-api.controller';

/**
 * The server order API (E05): a controller, a request DTO and a channel
 * adapter. Order rules, persistence and dispatch stay in `OrderIngestionModule`.
 * `edge/` holds the API's protection: rate limits, the error envelope and the
 * request log (the body limit is mounted from `main.ts`).
 */
@Module({
  imports: [DatabaseModule, IntegrationKeysModule, OrderIngestionModule],
  controllers: [OrderApiController],
  providers: [
    ApiOrderChannelAdapter,
    PhoneService,
    OrderApiIngressThrottleGuard,
    OrderApiThrottleGuard,
    OrderApiExceptionFilter,
    OrderApiOutcomeInterceptor,
  ],
})
export class OrderApiModule {}
