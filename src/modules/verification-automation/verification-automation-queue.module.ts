import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VERIFICATION_AUTOMATION_QUEUE_NAME } from './verification-automation.constants';
import { VerificationAutomationProducer } from './verification-automation.producer';

@Module({
  imports: [
    BullModule.registerQueue({ name: VERIFICATION_AUTOMATION_QUEUE_NAME }),
  ],
  providers: [VerificationAutomationProducer],
  exports: [VerificationAutomationProducer],
})
export class VerificationAutomationQueueModule {}
