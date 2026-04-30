import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { VERIFICATION_AUTOMATION_QUEUE_NAME } from './verification-automation.constants';
import { VerificationAutomationProducer } from './verification-automation.producer';
import { VerificationAutomationProcessor } from './verification-automation.processor';

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
    BullModule.registerQueue({ name: VERIFICATION_AUTOMATION_QUEUE_NAME }),
  ],
  providers: [VerificationAutomationProducer, VerificationAutomationProcessor],
  exports: [VerificationAutomationProducer],
})
export class VerificationAutomationModule {}
