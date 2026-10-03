import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { COMMERCE_OUTCOME_SYNC_QUEUE_NAME } from './commerce-outcome-sync.constants';
import { CommerceOutcomeSyncProducer } from './commerce-outcome-sync.producer';

@Module({
  imports: [
    BullModule.registerQueue({ name: COMMERCE_OUTCOME_SYNC_QUEUE_NAME }),
  ],
  providers: [CommerceOutcomeSyncProducer],
  exports: [CommerceOutcomeSyncProducer],
})
export class CommerceOutcomeSyncQueueModule {}
