import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const ONBOARDING_LANGUAGES = ['auto', 'en', 'ar'] as const;
export type OnboardingLanguage = (typeof ONBOARDING_LANGUAGES)[number];

export const ONBOARDING_STATUSES = ['pending', 'completed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_BILLING_PLAN_IDS = [
  'starter',
  'growth',
  'pro',
  'scale',
] as const;
export type OnboardingBillingPlanId =
  (typeof ONBOARDING_BILLING_PLAN_IDS)[number];

export class UpdateOnboardingSettingsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  storeName!: string;

  @IsString()
  @IsIn(ONBOARDING_LANGUAGES)
  defaultLanguage!: OnboardingLanguage;

  @IsBoolean()
  isAutoVerifyEnabled!: boolean;
}

export interface OnboardingStateDto {
  integrationId: string;
  onboardingStatus: OnboardingStatus;
  isOnboardingComplete: boolean;
  storeName: string | null;
  defaultLanguage: OnboardingLanguage;
  isAutoVerifyEnabled: boolean;
}

export interface OnboardingBillingResponseDto {
  confirmationUrl: string;
}

export interface OnboardingBillingPlanDto {
  id: OnboardingBillingPlanId;
  name: string;
  amount: number;
  currencyCode: string;
  includedVerifications: number;
  usage?: {
    cappedAmount: number;
    terms: string;
  };
}

export interface OnboardingBillingPlansResponseDto {
  plans: OnboardingBillingPlanDto[];
}

export class OnboardingBillingRequestDto {
  @IsString()
  @IsIn(ONBOARDING_BILLING_PLAN_IDS)
  planId!: OnboardingBillingPlanId;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  host?: string;
}
