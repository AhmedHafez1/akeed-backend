import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WebhookQueueModule } from '../webhook-queue/webhook-queue.module';
import { StandaloneOrderIngestionService } from './standalone-order-ingestion.service';

@Module({
  imports: [DatabaseModule, WebhookQueueModule],
  providers: [StandaloneOrderIngestionService],
  exports: [StandaloneOrderIngestionService],
})
export class OrderIngestionModule {}
