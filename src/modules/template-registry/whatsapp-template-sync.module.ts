import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { TemplateAlertService } from './template-alert.service';
import { TemplateStatusService } from './template-status.service';
import { WhatsappTemplateSyncQueueModule } from './whatsapp-template-sync-queue.module';
import { WhatsappTemplateSyncProcessor } from './whatsapp-template-sync.processor';
import { WhatsappTemplateSyncProducer } from './whatsapp-template-sync.producer';
import { WhatsappTemplateSyncService } from './whatsapp-template-sync.service';

/**
 * Template sync and template events (US-08-04). The provider catalog and the
 * registry come in through `TEMPLATE_CATALOG_PORT` and
 * `TEMPLATE_REGISTRY_PORT`, which the verification core module binds.
 */
@Module({
  imports: [DatabaseModule, WhatsappTemplateSyncQueueModule],
  providers: [
    TemplateAlertService,
    TemplateStatusService,
    WhatsappTemplateSyncService,
    WhatsappTemplateSyncProducer,
    WhatsappTemplateSyncProcessor,
  ],
  exports: [TemplateStatusService, WhatsappTemplateSyncService],
})
export class WhatsappTemplateSyncModule {}
