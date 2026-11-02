import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WhatsappConnectTicketsRepository } from '../../infrastructure/database/repositories/whatsapp-connect-tickets.repository';
import { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { AuthModule } from '../auth/auth.module';
import { WhatsappSenderController } from './whatsapp-sender.controller';
import { WhatsappSenderService } from './whatsapp-sender.service';

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule],
  controllers: [WhatsappSenderController],
  providers: [
    WhatsappSenderService,
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
