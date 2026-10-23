import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AUTO_CANCELLATION_QUEUE } from './auto-cancellation.constants';
import { AutoCancellationProducer } from './auto-cancellation.producer';

/** The queue and its producer, for modules that only schedule work on it. */
@Module({
  imports: [BullModule.registerQueue({ name: AUTO_CANCELLATION_QUEUE })],
  providers: [AutoCancellationProducer],
  exports: [AutoCancellationProducer, BullModule],
})
export class AutoCancellationQueueModule {}
