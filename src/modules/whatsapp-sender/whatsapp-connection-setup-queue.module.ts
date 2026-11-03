import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WHATSAPP_CONNECTION_SETUP_QUEUE } from './whatsapp-connection-setup-queue.constants';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

@Module({
  imports: [
    BullModule.registerQueue({ name: WHATSAPP_CONNECTION_SETUP_QUEUE }),
  ],
  providers: [WhatsappConnectionSetupProducer],
  exports: [BullModule, WhatsappConnectionSetupProducer],
})
export class WhatsappConnectionSetupQueueModule {}
