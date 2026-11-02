import { Module } from '@nestjs/common';
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
    DatabaseModule,
    BullModule.registerQueue({ name: REPLY_FOLLOW_UP_MAINTENANCE_QUEUE }),
  ],
  providers: [
    CustomerReplyFollowUpService,
    ReplyFollowUpMaintenanceProcessor,
    ReplyFollowUpMaintenanceScheduler,
  ],
  exports: [CustomerReplyFollowUpService],
})
export class VerificationRepliesModule {}
