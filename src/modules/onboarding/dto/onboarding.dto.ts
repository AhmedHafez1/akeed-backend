import type { CreditAccountStatus } from '../../../shared/ports/credit-accounting.port';
import { BILLING_PLAN_IDS } from '../../../shared/billing/billing-plan';
import type { BillingManagement } from '../../../shared/billing/entitlement';
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
import {
  ARABIC_COD_TEMPLATE_VARIANTS,
  ENGLISH_COD_TEMPLATE_VARIANTS,
  type ArabicCodTemplateVariantId,
  type CodTemplateDefinition,
  type EnglishCodTemplateVariantId,
} from '../../../shared/messaging/cod-template-catalog';

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

export const ONBOARDING_BILLING_PLAN_IDS = BILLING_PLAN_IDS;
export type OnboardingBillingPlanId = (typeof BILLING_PLAN_IDS)[number];

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

export const STANDALONE_SETUP_BLOCKED_REASONS = [
  'source_invalid',
  'approval_required',
  'pilot_entitlement_missing',
  'merchant_name_missing',
  'language_invalid',
  'cod_default_invalid',
  'automation_invalid',
  'timezone_invalid',
] as const;
export type StandaloneSetupBlockedReason =
  (typeof STANDALONE_SETUP_BLOCKED_REASONS)[number];

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
  @IsBoolean()
  assumeCodWhenPaymentMissing?: boolean;

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
  @IsBoolean()
  escalationEnabled?: boolean;

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

  @IsOptional()
  @IsString()
  @IsIn(ARABIC_COD_TEMPLATE_VARIANTS)
  codTemplateArVariant?: ArabicCodTemplateVariantId;

  @IsOptional()
  @IsString()
  @IsIn(ENGLISH_COD_TEMPLATE_VARIANTS)
  codTemplateEnVariant?: EnglishCodTemplateVariantId;
}

export interface OnboardingStateDto {
  integrationId: string;
  source: {
    platformType: string;
    identity: string;
  };
  onboardingStatus: OnboardingStatus;
  isOnboardingComplete: boolean;
  storeName: string | null;
  defaultLanguage: OnboardingLanguage;
  isAutoVerifyEnabled: boolean;
  assumeCodWhenPaymentMissing: boolean;
  shippingCurrency: OnboardingShippingCurrency;
  avgShippingCost: number;
  billingPlanId: OnboardingBillingPlanId | null;
  billingStatus: string | null;
  billingManagement: BillingManagement;
  followUpEnabled: boolean;
  followUpDelayMinutes: number;
  escalationEnabled: boolean;
  escalationDelayMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: AutomationTimezone;
  sendDelayMinutes: number;
  permissions: {
    canUpdateConfiguration: boolean;
    canCompleteOnboarding: boolean;
  };
  standaloneSetup: {
    canComplete: boolean;
    blockedReasons: StandaloneSetupBlockedReason[];
    approvalStatus: CreditAccountStatus | null;
  } | null;
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
  billingManagement: BillingManagement;
  plans: OnboardingBillingPlanDto[];
  isFreePlanClaimed: boolean;
}

export interface SettingsResponseDto {
  state: OnboardingStateDto;
  billing: {
    plans: OnboardingBillingPlanDto[];
    isFreePlanClaimed: boolean;
    usage: {
      used: number;
      limit: number;
      periodStart: string;
      periodEnd: string;
    };
  };
  template: {
    languages: Array<'ar' | 'en'>;
    defaultPreviewLanguage: 'ar' | 'en';
    defaults: {
      ar: ArabicCodTemplateVariantId;
      en: EnglishCodTemplateVariantId;
    };
    selected: {
      ar: ArabicCodTemplateVariantId;
      en: EnglishCodTemplateVariantId;
    };
    variants: {
      ar: CodTemplateDefinition[];
      en: CodTemplateDefinition[];
    };
    previews: {
      ar: MessageTemplatePreviewDto;
      en: MessageTemplatePreviewDto;
    };
  };
}

export interface MessageTemplatePreviewDto {
  greeting: string;
  body: string;
  totalLabel: string;
  ending: string;
  confirmButton: string;
  cancelButton: string;
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
