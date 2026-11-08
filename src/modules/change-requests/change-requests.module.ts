import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CommerceOutcomeModule } from '../commerce-outcomes/commerce-outcome.module';
import { VerificationAutomationQueueModule } from '../verification-automation/verification-automation-queue.module';
import { ChangeRequestLifecycleService } from './change-request-lifecycle.service';
import { ChangeRequestAcknowledgmentService } from './change-request-acknowledgment.service';

/**
 * Customer change requests: the domain commands later stories call from the
 * WhatsApp webhook, the dashboard and the resend flow.
 */
@Global()
@Module({
  imports: [
    DatabaseModule,
    CommerceOutcomeModule,
    VerificationAutomationQueueModule,
  ],
  providers: [
    ChangeRequestLifecycleService,
    ChangeRequestAcknowledgmentService,
  ],
  exports: [ChangeRequestLifecycleService, ChangeRequestAcknowledgmentService],
})
export class ChangeRequestsModule {}
