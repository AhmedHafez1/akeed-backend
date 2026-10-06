import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { VerificationAutomationQueueModule } from './verification-automation-queue.module';
import { VerificationAutomationProcessor } from './verification-automation.processor';
import { VerificationRepliesModule } from '../verification-replies/verification-replies.module';

/**
 * Module that hosts the verification-automation BullMQ queue.
 *
 * Relies on the global BullMQ root configuration registered in `AppModule`;
 * only registers the queue itself, the producer, and the processor.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    VerificationAutomationQueueModule,
    VerificationRepliesModule,
  ],
  providers: [VerificationAutomationProcessor],
})
export class VerificationAutomationModule {}
