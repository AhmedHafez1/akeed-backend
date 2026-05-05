import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const ONBOARDING_LANGUAGES = ['auto', 'en', 'ar'] as const;
export type OnboardingLanguage = (typeof ONBOARDING_LANGUAGES)[number];
export const ONBOARDING_SHIPPING_CURRENCIES = [
  'USD',
  'EUR',
  'EGP',
  'SAR',
  'AED',
  'QAR',
  'KWD',
  'BHD',
  'OMR',
  'JOD',
  'MAD',
] as const;
export type OnboardingShippingCurrency =
  (typeof ONBOARDING_SHIPPING_CURRENCIES)[number];

export const ONBOARDING_STATUSES = ['pending', 'completed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_BILLING_PLAN_IDS = [
  'starter',
  'basic',
  'pro',
  'business',
] as const;
export type OnboardingBillingPlanId =
  (typeof ONBOARDING_BILLING_PLAN_IDS)[number];

export const AUTOMATION_TIMEZONES = [
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Qatar',
  'Asia/Kuwait',
  'Asia/Bahrain',
  'Asia/Muscat',
  'Asia/Amman',
  'Africa/Cairo',
  'Africa/Casablanca',
  'UTC',
] as const;
export type AutomationTimezone = (typeof AUTOMATION_TIMEZONES)[number];

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

  @IsOptional()
  @IsString()
  @IsIn(ONBOARDING_SHIPPING_CURRENCIES)
  shippingCurrency?: OnboardingShippingCurrency;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  avgShippingCost?: number;

  @IsOptional()
  @IsBoolean()
  followUpEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  @Max(10080)
  followUpDelayMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  @Max(10080)
  escalationDelayMinutes?: number;

  @IsOptional()
  @IsBoolean()
  quietHoursEnabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'quietHoursStart must be in HH:mm format',
  })
  quietHoursStart?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'quietHoursEnd must be in HH:mm format',
  })
  quietHoursEnd?: string;

  @IsOptional()
  @IsString()
  @IsIn(AUTOMATION_TIMEZONES)
  timezone?: AutomationTimezone;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  @Max(1440)
  sendDelayMinutes?: number;
}

export interface OnboardingStateDto {
  integrationId: string;
  onboardingStatus: OnboardingStatus;
  isOnboardingComplete: boolean;
  storeName: string | null;
  defaultLanguage: OnboardingLanguage;
  isAutoVerifyEnabled: boolean;
  shippingCurrency: OnboardingShippingCurrency;
  avgShippingCost: number;
  billingPlanId: OnboardingBillingPlanId | null;
  billingStatus: string | null;
  billingManagementUrl: string | null;
  followUpEnabled: boolean;
  followUpDelayMinutes: number;
  escalationDelayMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: AutomationTimezone;
  sendDelayMinutes: number;
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
}

export interface OnboardingBillingPlansResponseDto {
  plans: OnboardingBillingPlanDto[];
  isFreePlanClaimed: boolean;
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
