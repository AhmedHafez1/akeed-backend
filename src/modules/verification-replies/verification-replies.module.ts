import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsappConnectionsRepository } from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import { BullModule } from '@nestjs/bullmq';
import {
  REPLY_FOLLOW_UP_MAINTENANCE_QUEUE,
  ReplyFollowUpMaintenanceProcessor,
  ReplyFollowUpMaintenanceScheduler,
} from './reply-follow-up-maintenance';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CustomerReplyFollowUpService } from './customer-reply-follow-up.service';

/**
 * What Akeed sends after a customer replies. The messaging
 * port, the switches and the texts come from the global verification core.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    BullModule.registerQueue({ name: REPLY_FOLLOW_UP_MAINTENANCE_QUEUE }),
  ],
  providers: [
    WhatsappConnectionsRepository,
    CustomerReplyFollowUpService,
    ReplyFollowUpMaintenanceProcessor,
    ReplyFollowUpMaintenanceScheduler,
  ],
  exports: [CustomerReplyFollowUpService],
})
export class VerificationRepliesModule {}
