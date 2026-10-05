import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WHATSAPP_TEMPLATE_SYNC_QUEUE } from './whatsapp-template-sync-queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: WHATSAPP_TEMPLATE_SYNC_QUEUE })],
  exports: [BullModule],
})
export class WhatsappTemplateSyncQueueModule {}
