import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OnboardingBillingPlanId } from '../dto/onboarding.dto';
import {
  type BillingPlanConfig,
  resolveBillingPlan,
  resolveBillingPlans,
  resolveBooleanConfig,
} from './onboarding.service.helpers';

@Injectable()
export class BillingConfigService {
  constructor(private readonly configService: ConfigService) {}

  resolvePlan(planId: OnboardingBillingPlanId): BillingPlanConfig {
    return resolveBillingPlan({
      planId,
      currencyCode: this.getCurrencyCode(),
      testMode: this.getTestMode(),
    });
  }

  resolveAllPlans(): BillingPlanConfig[] {
    return resolveBillingPlans({
      currencyCode: this.getCurrencyCode(),
      testMode: this.getTestMode(),
    });
  }

  isBillingRequired(): boolean {
    return this.getBooleanConfig('SHOPIFY_BILLING_REQUIRED', true);
  }

  shouldSkipCustomAppBillingError(): boolean {
    return this.getBooleanConfig('SHOPIFY_BILLING_SKIP_CUSTOM_APP_ERROR', true);
  }

  getCurrencyCode(): string {
    return this.configService.get<string>('SHOPIFY_BILLING_CURRENCY') ?? 'USD';
  }

  getTestMode(): boolean {
    return this.getBooleanConfig(
      'SHOPIFY_BILLING_TEST_MODE',
      this.configService.get<string>('NODE_ENV') !== 'production',
    );
  }

  getApiUrl(): string {
    return this.configService.getOrThrow<string>('API_URL');
  }

  getAppUrl(): string {
    return this.configService.getOrThrow<string>('APP_URL');
  }

  getApiKey(): string | undefined {
    return this.configService.get<string>('SHOPIFY_API_KEY');
  }

  getApiSecret(): string {
    return this.configService.getOrThrow<string>('SHOPIFY_API_SECRET');
  }

  private getBooleanConfig(key: string, defaultValue: boolean): boolean {
    return resolveBooleanConfig(
      this.configService.get<string>(key),
      defaultValue,
    );
  }
}
