import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { VerificationsController } from './verifications.controller';
import { VerificationsService } from './verifications.service';
import { TestVerificationService } from './test-verification.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [VerificationsController],
  providers: [VerificationsService, TestVerificationService],
  exports: [VerificationsService, TestVerificationService],
})
export class VerificationsModule {}
