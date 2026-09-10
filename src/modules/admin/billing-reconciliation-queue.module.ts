import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BILLING_RECONCILIATION_QUEUE } from './billing-reconciliation-queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: BILLING_RECONCILIATION_QUEUE })],
  exports: [BullModule],
})
export class BillingReconciliationQueueModule {}
