import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ORDER_IMPORT_QUEUE } from './order-import-queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: ORDER_IMPORT_QUEUE })],
  exports: [BullModule],
})
export class OrderImportQueueModule {}
