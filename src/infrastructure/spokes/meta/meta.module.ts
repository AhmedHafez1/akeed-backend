import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsAppService } from './whatsapp.service';
import { ConfigModule } from '@nestjs/config';

import { WhatsAppWebhookController } from './whatsapp.webhook.controller';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import { DatabaseModule } from '../../database/database.module';
import { CoreModule } from 'src/core/core.module';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    DatabaseModule,
    forwardRef(() => CoreModule),
  ],
  controllers: [WhatsAppWebhookController],
  providers: [WhatsAppService, WhatsAppWebhookService],
  exports: [WhatsAppService],
})
export class MetaModule {}
