import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { WhatsAppService } from './whatsapp.service';
import { ConfigModule } from '@nestjs/config';

import { WhatsAppWebhookController } from './whatsapp.webhook.controller';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import { DatabaseModule } from '../../database/database.module';
import { WhatsappTemplateSyncModule } from '../../../modules/template-registry/whatsapp-template-sync.module';
import { WhatsappSenderModule } from '../../../modules/whatsapp-sender/whatsapp-sender.module';
import { MetaTemplateCatalogAdapter } from './meta-template-catalog.adapter';
import { MetaTemplateWebhookHandler } from './meta-template-webhook.handler';
import { VerificationAutomationQueueModule } from '../../../modules/verification-automation/verification-automation-queue.module';
import { MetaWebhookEventsProcessor } from './meta-webhook-events.processor';
import { MetaWebhookEventsScheduler } from './meta-webhook-events.scheduler';
import { MetaWebhookEventsService } from './meta-webhook-events.service';
import { MetaWebhookIntakeInterceptor } from './meta-webhook-intake.interceptor';
import { META_WEBHOOK_QUEUE } from './meta-webhook-queue.constants';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    DatabaseModule,
    WhatsappTemplateSyncModule,
    // Template webhooks for merchants' own accounts.
    WhatsappSenderModule,
    VerificationAutomationQueueModule,
    BullModule.registerQueue({ name: META_WEBHOOK_QUEUE }),
  ],
  controllers: [WhatsAppWebhookController],
  providers: [
    WhatsAppService,
    WhatsAppWebhookService,
    MetaTemplateCatalogAdapter,
    MetaTemplateWebhookHandler,
    MetaWebhookEventsService,
    MetaWebhookEventsProcessor,
    MetaWebhookEventsScheduler,
    MetaWebhookIntakeInterceptor,
  ],
  exports: [WhatsAppService, MetaTemplateCatalogAdapter],
})
export class MetaModule {}
