import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CommerceOutcomeSyncQueueModule } from './commerce-outcome-sync-queue.module';
import { CommerceOutcomeSyncTracker } from './commerce-outcome-sync-tracker.service';
import { CommerceOutcomeSyncProcessor } from './commerce-outcome-sync.processor';

/**
 * Sync-state tracking and its retry worker (US-06-04). Kept apart from
 * `CommerceOutcomeModule` so the registry still loads without a queue: where
 * this module is absent the registry has no tracker and dispatches exactly as
 * it did before sync states existed. Global, so the registry finds the tracker
 * without importing the queue.
 */
@Global()
@Module({
  imports: [DatabaseModule, CommerceOutcomeSyncQueueModule],
  providers: [CommerceOutcomeSyncTracker, CommerceOutcomeSyncProcessor],
  exports: [CommerceOutcomeSyncTracker],
})
export class CommerceOutcomeSyncModule {}
