import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { PhoneService } from '../../shared/services/phone.service';
import { IntegrationKeysModule } from '../integration-keys/integration-keys.module';
import { OrderIngestionModule } from '../order-ingestion/order-ingestion.module';
import { ApiOrderChannelAdapter } from './api-order.channel-adapter';
import { OrderApiController } from './order-api.controller';

/**
 * The server order API (E05): a controller, a request DTO and a channel
 * adapter. Order rules, persistence and dispatch stay in `OrderIngestionModule`.
 */
@Module({
  imports: [DatabaseModule, IntegrationKeysModule, OrderIngestionModule],
  controllers: [OrderApiController],
  providers: [ApiOrderChannelAdapter, PhoneService],
})
export class OrderApiModule {}
