import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../../../infrastructure/database/database.module';
import { ShopifyModule } from '../../../infrastructure/spokes/shopify/shopify.module';
import { OnboardingBillingCallbackController } from '../../controllers/onboarding-billing-callback.controller';
import { OnboardingController } from '../../controllers/onboarding.controller';
import { OnboardingService } from '../../services/onboarding.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule, forwardRef(() => ShopifyModule)],
  controllers: [OnboardingController, OnboardingBillingCallbackController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
