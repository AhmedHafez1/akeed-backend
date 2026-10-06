import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CustomerReplyFollowUpService } from './customer-reply-follow-up.service';

/**
 * What Akeed sends after a customer replies (US-08-07 b, c). The messaging
 * port, the switches and the texts come from the global verification core.
 */
@Module({
  imports: [DatabaseModule],
  providers: [CustomerReplyFollowUpService],
  exports: [CustomerReplyFollowUpService],
})
export class VerificationRepliesModule {}
