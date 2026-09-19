import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AuthModule } from '../auth/auth.module';
import { WebhookQueueModule } from '../webhook-queue/webhook-queue.module';
import { PhoneService } from '../../shared/services/phone.service';
import { OrderIngestionModule } from '../order-ingestion/order-ingestion.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    WebhookQueueModule,
    OrderIngestionModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, PhoneService],
  exports: [OrdersService],
})
export class OrdersModule {}
