import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { CAPACITY_RECOVERY_QUEUE } from './capacity-recovery.constants';
import { CapacityRecoveryProducer } from './capacity-recovery.producer';

/** The queue and its producer, for modules that only ask for recovery. */
@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({ name: CAPACITY_RECOVERY_QUEUE }),
  ],
  providers: [CapacityRecoveryProducer],
  exports: [CapacityRecoveryProducer, BullModule],
})
export class CapacityRecoveryQueueModule {}
