import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CommerceOutcomeModule } from '../commerce-outcomes/commerce-outcome.module';
import { AutoCancellationQueueModule } from './auto-cancellation-queue.module';
import { AutoCancellationProcessor } from './auto-cancellation.processor';
import { AutoCancellationScheduler } from './auto-cancellation.scheduler';
import { AutoCancellationService } from './auto-cancellation.service';

/**
 * Automatic cancellation of unanswered orders: the decision when an order
 * reaches `no_reply`, the worker that cancels it in its store, and the
 * merchant's per-order exclusion.
 */
@Module({
  imports: [DatabaseModule, CommerceOutcomeModule, AutoCancellationQueueModule],
  providers: [
    AutoCancellationService,
    AutoCancellationProcessor,
    AutoCancellationScheduler,
  ],
  exports: [AutoCancellationService],
})
export class AutoCancellationModule {}
