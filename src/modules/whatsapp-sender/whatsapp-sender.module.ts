import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WhatsappConnectTicketsRepository } from '../../infrastructure/database/repositories/whatsapp-connect-tickets.repository';
import { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';
import { OwnNumberGraphClient } from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import { AuthModule } from '../auth/auth.module';
import { WhatsappConnectController } from './whatsapp-connect.controller';
import { WhatsappConnectService } from './whatsapp-connect.service';
import { WhatsappSenderController } from './whatsapp-sender.controller';
import { WhatsappSenderService } from './whatsapp-sender.service';

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule],
  controllers: [WhatsappSenderController, WhatsappConnectController],
  providers: [
    WhatsappSenderService,
    WhatsappConnectService,
    OwnNumberGraphClient,
    MembershipsRepository,
    WhatsappConnectionsRepository,
    WhatsappConnectTicketsRepository,
    WhatsappConnectionTemplatesRepository,
  ],
  exports: [
    WhatsappConnectionsRepository,
    WhatsappConnectTicketsRepository,
    WhatsappConnectionTemplatesRepository,
  ],
})
export class WhatsappSenderModule {}
