import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CapacityRecoveryQueueModule } from './capacity-recovery-queue.module';
import { CapacityRecoveryProcessor } from './capacity-recovery.processor';
import { CapacityRecoveryScheduler } from './capacity-recovery.scheduler';
import { CapacityRecoveryService } from './capacity-recovery.service';

/**
 * The worker side of capacity recovery. The verification core it calls is a
 * global module; the producer other modules use comes from
 * `CapacityRecoveryQueueModule`.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, CapacityRecoveryQueueModule],
  providers: [
    CapacityRecoveryService,
    CapacityRecoveryProcessor,
    CapacityRecoveryScheduler,
  ],
})
export class CapacityRecoveryModule {}
