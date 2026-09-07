import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';

export const BILLING_PLAN_IDS = [
  'starter',
  'basic',
  'pro',
  'business',
] as const;
export type BillingPlanId = (typeof BILLING_PLAN_IDS)[number];

interface BillingPlanTemplate {
  name: string;
  amount: number;
  includedVerifications: number;
}

export interface BillingPlanConfig {
  id: BillingPlanId;
  name: string;
  amount: number;
  currencyCode: string;
  testMode: boolean;
  includedVerifications: number;
}

const BILLING_PLAN_TEMPLATES: Record<BillingPlanId, BillingPlanTemplate> = {
  starter: {
    name: 'Akeed Starter',
    amount: 0,
    includedVerifications: 30,
  },
  basic: {
    name: 'Akeed Basic',
    amount: 9.99,
    includedVerifications: 300,
  },
  pro: {
    name: 'Akeed Pro',
    amount: 22.99,
    includedVerifications: 1000,
  },
  business: {
    name: 'Akeed Scale',
    amount: 49.99,
    includedVerifications: 2500,
  },
};

export const DEFAULT_BILLING_PLAN_ID: BillingPlanId = 'starter';

/**
 * Entitlement grant for a Standalone source.
 *
 * Standalone tenants settle no external billing, but `resolveEntitlement` still
 * demands a status, a valid plan and an activation anchor before it hands out a
 * limit — there is no default-plan fallback for them the way there is for
 * Shopify. Provisioning and the admin pilot grant must agree on these exact
 * values, so they live here rather than being restated at each write site.
 */
export const STANDALONE_BILLING_STATUS = 'not_required';
export const STANDALONE_DEFAULT_PLAN_ID: BillingPlanId = 'starter';

export function isBillingPlanId(value: string): value is BillingPlanId {
  return BILLING_PLAN_IDS.includes(value as BillingPlanId);
}

export function resolveIncludedVerificationsLimit(
  planId: BillingPlanId,
): number {
  const planTemplate = BILLING_PLAN_TEMPLATES[planId];
  if (!planTemplate) {
    throw new BadRequestException(`Unsupported billing plan: ${planId}`);
  }

  return planTemplate.includedVerifications;
}

export function resolveBillingPlan(params: {
  planId: BillingPlanId;
  currencyCode: string;
  testMode: boolean;
}): BillingPlanConfig {
  const planTemplate = BILLING_PLAN_TEMPLATES[params.planId];
  if (!planTemplate) {
    throw new BadRequestException(`Unsupported billing plan: ${params.planId}`);
  }

  const billingPlan: BillingPlanConfig = {
    id: params.planId,
    name: planTemplate.name,
    amount: planTemplate.amount,
    currencyCode: params.currencyCode,
    testMode: params.testMode,
    includedVerifications: planTemplate.includedVerifications,
  };

  validateBillingPlan(billingPlan);
  return billingPlan;
}

export function resolveBillingPlans(params: {
  currencyCode: string;
  testMode: boolean;
}): BillingPlanConfig[] {
  return BILLING_PLAN_IDS.map((planId) =>
    resolveBillingPlan({
      planId,
      currencyCode: params.currencyCode,
      testMode: params.testMode,
    }),
  );
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
}
