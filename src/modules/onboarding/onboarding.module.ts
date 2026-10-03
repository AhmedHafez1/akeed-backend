import { SUBSCRIPTION_BILLING_PORT } from '../../shared/ports/subscription-billing.port';
import { ShopifyBillingAdapter } from '../../infrastructure/spokes/shopify/services/shopify-billing.adapter';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ShopifyModule } from '../../infrastructure/spokes/shopify/shopify.module';
import { OnboardingBillingCallbackController } from './onboarding-billing-callback.controller';
import { OnboardingController } from './onboarding.controller';
import { SettingsController } from './settings.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingStateService } from './onboarding-state.service';
import { BillingService } from './billing.service';
import { BillingConfigService } from './billing-config.service';
import { BillingCallbackRateLimitGuard } from '../../shared/guards/billing-callback-rate-limit.guard';
import { ShopifyBillingCallbackValidationGuard } from '../../shared/guards/shopify-billing-callback-validation.guard';
import { STORE_PLATFORM_PORT } from '../../shared/ports/store-platform.port';
import { ShopifyApiService } from '../../infrastructure/spokes/shopify/services/shopify-api.service';
import { AuthModule } from '../auth/auth.module';
import { PhoneService } from '../../shared/services/phone.service';
import { SOURCE_SETUP_CONTRIBUTORS } from '../../shared/commerce/source-setup';
import { EasyOrdersIngestionModule } from '../../infrastructure/spokes/easyorders/easyorders-ingestion.module';
import { EasyOrdersSetupContributor } from '../../infrastructure/spokes/easyorders/easyorders-setup.contributor';
import { SourceSetupService } from './source-setup.service';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ShopifyModule,
    EasyOrdersIngestionModule,
  ],
  controllers: [
    OnboardingController,
    OnboardingBillingCallbackController,
    SettingsController,
  ],
  providers: [
    OnboardingService,
    OnboardingStateService,
    BillingService,
    BillingConfigService,
    BillingCallbackRateLimitGuard,
    ShopifyBillingCallbackValidationGuard,
    PhoneService,
    { provide: SUBSCRIPTION_BILLING_PORT, useExisting: ShopifyBillingAdapter },
    { provide: STORE_PLATFORM_PORT, useExisting: ShopifyApiService },
    // One contributor per source whose connection has state of its own. A
    // new source adds its contributor here; the services never name one.
    {
      provide: SOURCE_SETUP_CONTRIBUTORS,
      inject: [EasyOrdersSetupContributor],
      useFactory: (easyOrders: EasyOrdersSetupContributor) => [easyOrders],
    },
    SourceSetupService,
  ],
  exports: [
    OnboardingService,
    OnboardingStateService,
    BillingService,
    BillingConfigService,
  ],
})
export class OnboardingModule {}
