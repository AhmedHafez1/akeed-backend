import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { VerificationsController } from './verifications.controller';
import { ChangeRequestsController } from './change-requests.controller';
import { ChangeRequestMerchantService } from './change-request-merchant.service';
import { VerificationsService } from './verifications.service';
import { TestVerificationService } from './test-verification.service';
import { AuthModule } from '../auth/auth.module';
import { PhoneService } from '../../shared/services/phone.service';
import { OnboardingTestController } from './onboarding-test.controller';
import { OnboardingTestService } from './onboarding-test.service';
import { AutoCancellationModule } from '../auto-cancellation/auto-cancellation.module';

@Module({
  imports: [DatabaseModule, AuthModule, AutoCancellationModule],
  controllers: [
    VerificationsController,
    ChangeRequestsController,
    OnboardingTestController,
  ],
  providers: [
    VerificationsService,
    ChangeRequestMerchantService,
    TestVerificationService,
    OnboardingTestService,
    PhoneService,
  ],
  exports: [VerificationsService, TestVerificationService],
})
export class VerificationsModule {}
