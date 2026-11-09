import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CommerceOutcomeModule } from '../commerce-outcomes/commerce-outcome.module';
import { VerificationAutomationQueueModule } from '../verification-automation/verification-automation-queue.module';
import { ChangeRequestLifecycleService } from './change-request-lifecycle.service';
import { ChangeRequestAcknowledgmentService } from './change-request-acknowledgment.service';
import { ChangeRequestEffectsService } from './change-request-effects.service';

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
    ChangeRequestEffectsService,
  ],
  exports: [
    ChangeRequestLifecycleService,
    ChangeRequestAcknowledgmentService,
    ChangeRequestEffectsService,
  ],
})
export class ChangeRequestsModule {}
