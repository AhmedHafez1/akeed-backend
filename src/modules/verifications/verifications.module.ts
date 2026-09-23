import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { VerificationsController } from './verifications.controller';
import { VerificationsService } from './verifications.service';
import { TestVerificationService } from './test-verification.service';
import { AuthModule } from '../auth/auth.module';
import { PhoneService } from '../../shared/services/phone.service';
import { OnboardingTestController } from './onboarding-test.controller';
import { OnboardingTestService } from './onboarding-test.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [VerificationsController, OnboardingTestController],
  providers: [
    VerificationsService,
    TestVerificationService,
    OnboardingTestService,
    PhoneService,
  ],
  exports: [VerificationsService, TestVerificationService],
})
export class VerificationsModule {}
