import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WebhookQueueModule } from '../webhook-queue/webhook-queue.module';
import { StandaloneOrderIngestionService } from './standalone-order-ingestion.service';
import { StandaloneSourceResolver } from './standalone-source-resolver';
import { StandaloneSendReadinessService } from './standalone-send-readiness.service';

@Module({
  imports: [DatabaseModule, WebhookQueueModule],
  providers: [
    StandaloneOrderIngestionService,
    StandaloneSourceResolver,
    StandaloneSendReadinessService,
  ],
  exports: [StandaloneOrderIngestionService, StandaloneSendReadinessService],
})
export class OrderIngestionModule {}
