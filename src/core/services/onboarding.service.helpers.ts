import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  ONBOARDING_BILLING_PLAN_IDS,
  type OnboardingBillingPlanId,
} from '../dto/onboarding.dto';

interface BillingPlanUsageTemplate {
  cappedAmount: number;
  overageRate: number;
}

interface BillingPlanTemplate {
  name: string;
  amount: number;
  includedVerifications: number;
  usage?: BillingPlanUsageTemplate;
}

export interface BillingPlanUsageConfig {
  cappedAmount: number;
  terms: string;
}

export interface BillingPlanConfig {
  id: OnboardingBillingPlanId;
  name: string;
  amount: number;
  currencyCode: string;
  testMode: boolean;
  includedVerifications: number;
  usage?: BillingPlanUsageConfig;
}

export interface BillingRedirectParams {
  shop: string;
  host?: string;
}

const BILLING_PLAN_TEMPLATES: Record<
  OnboardingBillingPlanId,
  BillingPlanTemplate
> = {
  starter: {
    name: 'Akeed Starter',
    amount: 0,
    includedVerifications: 50,
  },
  growth: {
    name: 'Akeed Growth',
    amount: 9,
    includedVerifications: 500,
    usage: {
      cappedAmount: 25,
      overageRate: 0.03,
    },
  },
  pro: {
    name: 'Akeed Pro',
    amount: 15,
    includedVerifications: 1000,
    usage: {
      cappedAmount: 45,
      overageRate: 0.025,
    },
  },
  scale: {
    name: 'Akeed Scale',
    amount: 29,
    includedVerifications: 2500,
    usage: {
      cappedAmount: 90,
      overageRate: 0.02,
    },
  },
};

export const DEFAULT_BILLING_PLAN_ID: OnboardingBillingPlanId = 'starter';

export function isOnboardingBillingPlanId(
  value: string,
): value is OnboardingBillingPlanId {
  return ONBOARDING_BILLING_PLAN_IDS.includes(value as OnboardingBillingPlanId);
}

export function resolveIncludedVerificationsLimit(
  planId: OnboardingBillingPlanId,
): number {
  const planTemplate = BILLING_PLAN_TEMPLATES[planId];
  if (!planTemplate) {
    throw new BadRequestException(`Unsupported billing plan: ${planId}`);
  }

  return planTemplate.includedVerifications;
}

export function resolveBillingPlan(params: {
  planId: OnboardingBillingPlanId;
  currencyCode: string;
  testMode: boolean;
}): BillingPlanConfig {
  const planTemplate = BILLING_PLAN_TEMPLATES[params.planId];
  if (!planTemplate) {
    throw new BadRequestException(`Unsupported billing plan: ${params.planId}`);
  }

  const usage = planTemplate.usage
    ? {
        cappedAmount: planTemplate.usage.cappedAmount,
        terms: buildUsageTerms({
          includedVerifications: planTemplate.includedVerifications,
          overageRate: planTemplate.usage.overageRate,
          currencyCode: params.currencyCode,
        }),
      }
    : undefined;

  const billingPlan: BillingPlanConfig = {
    id: params.planId,
    name: planTemplate.name,
    amount: planTemplate.amount,
    currencyCode: params.currencyCode,
    testMode: params.testMode,
    includedVerifications: planTemplate.includedVerifications,
    usage,
  };

  validateBillingPlan(billingPlan);
  return billingPlan;
}

export function resolveBillingPlans(params: {
  currencyCode: string;
  testMode: boolean;
}): BillingPlanConfig[] {
  return ONBOARDING_BILLING_PLAN_IDS.map((planId) =>
    resolveBillingPlan({
      planId,
      currencyCode: params.currencyCode,
      testMode: params.testMode,
    }),
  );
}

export function buildBillingReturnUrl(
  apiUrl: string,
  shopDomain: string,
  host?: string,
): string {
  const url = new URL('/api/onboarding/billing/callback', apiUrl);
  url.searchParams.set('shop', shopDomain);
  if (host) {
    url.searchParams.set('host', host);
  }
  return url.toString();
}

export function buildPostBillingRedirectUrl(
  appUrl: string,
  params: BillingRedirectParams,
): string {
  const url = new URL(appUrl);
  url.searchParams.set('shop', params.shop);

  if (params.host) {
    url.searchParams.set('host', params.host);
  }

  return url.toString();
}

export function resolveBooleanConfig(
  rawValue: string | undefined,
  defaultValue: boolean,
): boolean {
  if (rawValue === undefined) {
    return defaultValue;
  }

  return parseBooleanConfig(rawValue);
}

function buildUsageTerms(params: {
  includedVerifications: number;
  overageRate: number;
  currencyCode: string;
}): string {
  return `Includes ${params.includedVerifications} successful verifications/month. Additional successful verifications are billed at ${params.overageRate} ${params.currencyCode} each.`;
}

function validateBillingPlan(plan: BillingPlanConfig): void {
  if (!Number.isFinite(plan.amount) || plan.amount < 0) {
    throw new InternalServerErrorException(
      `Invalid billing amount for plan: ${plan.id}`,
    );
  }

  if (plan.includedVerifications <= 0) {
    throw new InternalServerErrorException(
      `Invalid included verification limit for plan: ${plan.id}`,
    );
  }

  if (plan.usage) {
    if (
      !Number.isFinite(plan.usage.cappedAmount) ||
      plan.usage.cappedAmount <= 0
    ) {
      throw new InternalServerErrorException(
        `Invalid billing capped amount for plan: ${plan.id}`,
      );
    }

    if (!plan.usage.terms.trim()) {
      throw new InternalServerErrorException(
        `Invalid billing usage terms for plan: ${plan.id}`,
      );
    }
  }
}

function parseBooleanConfig(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
