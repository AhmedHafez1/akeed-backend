import { SenderResolverService } from './sender-resolver.service';
import { ConnectionHealthService } from './connection-health.service';
import { SenderEventsService } from './sender-events.service';
import { MetaSenderHealthAdapter } from '../../infrastructure/spokes/meta/own-number/meta-sender-health.adapter';
import {
  SENDER_HEALTH_PORT,
  SENDER_EVENT_PORT,
} from '../../shared/ports/sender-recovery.port';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WhatsappConnectTicketsRepository } from '../../infrastructure/database/repositories/whatsapp-connect-tickets.repository';
import { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';
import { OwnNumberGraphClient } from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import { AuthModule } from '../auth/auth.module';
import { ConnectionSetupService } from './connection-setup.service';
import { ConnectionStatusService } from './connection-status.service';
import { ConnectionTemplateHintsService } from './connection-template-hints.service';
import { ConnectionTemplatesService } from './connection-templates.service';
import { WhatsappConnectController } from './whatsapp-connect.controller';
import { WhatsappConnectService } from './whatsapp-connect.service';
import { WhatsappConnectionSetupQueueModule } from './whatsapp-connection-setup-queue.module';
import { WhatsappConnectionSetupProcessor } from './whatsapp-connection-setup.processor';
import { WhatsappConnectionSetupScheduler } from './whatsapp-connection-setup.scheduler';
import { WhatsappSenderController } from './whatsapp-sender.controller';
import { WhatsappSenderService } from './whatsapp-sender.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    WhatsappConnectionSetupQueueModule,
  ],
  controllers: [WhatsappSenderController, WhatsappConnectController],
  providers: [
    ConnectionHealthService,
    SenderEventsService,
    MetaSenderHealthAdapter,
    { provide: SENDER_HEALTH_PORT, useExisting: MetaSenderHealthAdapter },
    { provide: SENDER_EVENT_PORT, useExisting: SenderEventsService },
    SenderResolverService,
    WhatsappSenderService,
    WhatsappConnectService,
    ConnectionSetupService,
    ConnectionTemplatesService,
    ConnectionTemplateHintsService,
    ConnectionStatusService,
    WhatsappConnectionSetupProcessor,
    WhatsappConnectionSetupScheduler,
    OwnNumberGraphClient,
    MembershipsRepository,
    WhatsappConnectionsRepository,
    WhatsappConnectTicketsRepository,
    WhatsappConnectionTemplatesRepository,
    WhatsappTemplatesRepository,
  ],
  exports: [
    SENDER_EVENT_PORT,
    SenderResolverService,
    WhatsappConnectionsRepository,
    WhatsappConnectTicketsRepository,
    WhatsappConnectionTemplatesRepository,
    ConnectionTemplateHintsService,
    ConnectionStatusService,
  ],
})
export class WhatsappSenderModule {}
