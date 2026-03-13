import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ShopifyModule } from '../../infrastructure/spokes/shopify/shopify.module';
import { OnboardingBillingCallbackController } from './onboarding-billing-callback.controller';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService } from './billing.service';
import { BillingConfigService } from './billing-config.service';
import { BillingCallbackRateLimitGuard } from '../../shared/guards/billing-callback-rate-limit.guard';
import { ShopifyBillingCallbackValidationGuard } from '../../shared/guards/shopify-billing-callback-validation.guard';
import { STORE_PLATFORM_PORT } from '../../shared/ports/store-platform.port';
import { ShopifyApiService } from '../../infrastructure/spokes/shopify/services/shopify-api.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule, ShopifyModule],
  controllers: [OnboardingController, OnboardingBillingCallbackController],
  providers: [
    OnboardingService,
    OnboardingStateService,
    BillingService,
    BillingConfigService,
    BillingCallbackRateLimitGuard,
    ShopifyBillingCallbackValidationGuard,
    { provide: STORE_PLATFORM_PORT, useExisting: ShopifyApiService },
  ],
  exports: [
    OnboardingService,
    OnboardingStateService,
    BillingService,
    BillingConfigService,
  ],
})
export class OnboardingModule {}
