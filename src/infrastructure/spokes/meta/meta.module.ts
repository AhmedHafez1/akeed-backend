import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsAppService } from './whatsapp.service';
import { ConfigModule } from '@nestjs/config';

import { WhatsAppWebhookController } from './whatsapp.webhook.controller';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import { DatabaseModule } from '../../database/database.module';
import { WhatsappTemplateSyncModule } from '../../../modules/template-registry/whatsapp-template-sync.module';
import { MetaTemplateCatalogAdapter } from './meta-template-catalog.adapter';
import { MetaTemplateWebhookHandler } from './meta-template-webhook.handler';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    DatabaseModule,
    WhatsappTemplateSyncModule,
  ],
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppService,
    WhatsAppWebhookService,
    MetaTemplateCatalogAdapter,
    MetaTemplateWebhookHandler,
  ],
  exports: [WhatsAppService, MetaTemplateCatalogAdapter],
})
export class MetaModule {}
