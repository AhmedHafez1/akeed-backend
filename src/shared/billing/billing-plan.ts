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
  /** The plan's own-number pool, set per plan rather than as a multiple. */
  ownNumberIncludedVerifications: number;
}

export interface BillingPlanConfig {
  id: BillingPlanId;
  name: string;
  amount: number;
  currencyCode: string;
  testMode: boolean;
  includedVerifications: number;
  ownNumberIncludedVerifications: number;
}

const BILLING_PLAN_TEMPLATES: Record<BillingPlanId, BillingPlanTemplate> = {
  starter: {
    name: 'Akeed Starter',
    amount: 0,
    includedVerifications: 60,
    ownNumberIncludedVerifications: 200,
  },
  basic: {
    name: 'Akeed Basic',
    amount: 9.99,
    includedVerifications: 300,
    ownNumberIncludedVerifications: 2000,
  },
  pro: {
    name: 'Akeed Pro',
    amount: 22.99,
    includedVerifications: 1000,
    ownNumberIncludedVerifications: 5000,
  },
  business: {
    name: 'Akeed Scale',
    amount: 49.99,
    includedVerifications: 2500,
    ownNumberIncludedVerifications: 20000,
  },
};

const LEGACY_PERIODIC_ALLOWANCES: Partial<
  Record<
    BillingPlanId,
    {
      includedLimit: number;
      ownNumberIncludedLimit: number;
    }
  >
> = {
  starter: { includedLimit: 30, ownNumberIncludedLimit: 90 },
  basic: { includedLimit: 300, ownNumberIncludedLimit: 1000 },
};

/**
 * Whether a plan is charged through a Shopify subscription (amount > 0). Reads
 * the plan templates, so it also works where `BillingConfigService` is not
 * available (the uninstall path in the repository).
 */
export function isPaidBillingPlan(planId: string | null | undefined): boolean {
  if (!planId || !isBillingPlanId(planId)) return false;
  return BILLING_PLAN_TEMPLATES[planId].amount > 0;
}

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

/**
 * Plans whose included verifications are a one-time allowance rather than a
 * 30-day rolling quota. Their usage lives in a single period that never rolls
 * over, so consuming the allowance is permanent until the store upgrades.
 */
export const ONE_TIME_BILLING_PLAN_IDS: readonly BillingPlanId[] = ['starter'];

/**
 * A connected own number adds a separate pool of messages, set per plan
 * (Basic: 300 Akeed + 2,000 own number). The pool shares the plan's period, so
 * Starter's one-time 60 come with a one-time 200. No plan, no pool.
 */
export function resolveOwnNumberIncludedVerifications(
  planId: BillingPlanId | null,
): number {
  return planId
    ? BILLING_PLAN_TEMPLATES[planId].ownNumberIncludedVerifications
    : 0;
}

export function isOneTimeBillingPlan(planId: BillingPlanId | null): boolean {
  return planId !== null && ONE_TIME_BILLING_PLAN_IDS.includes(planId);
}

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

/** Non-Shopify sources keep their legacy allowances when billed periodically. */
export function resolvePeriodicPlanAllowances(
  planId: BillingPlanId | null,
  billing: 'shopify' | 'legacy',
) {
  const legacyAllowance =
    billing === 'legacy' && planId
      ? LEGACY_PERIODIC_ALLOWANCES[planId]
      : undefined;
  return (
    legacyAllowance ?? {
      includedLimit: planId ? resolveIncludedVerificationsLimit(planId) : 0,
      ownNumberIncludedLimit: resolveOwnNumberIncludedVerifications(planId),
    }
  );
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
    ownNumberIncludedVerifications: planTemplate.ownNumberIncludedVerifications,
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

  if (plan.ownNumberIncludedVerifications <= 0) {
    throw new InternalServerErrorException(
      `Invalid own-number limit for plan: ${plan.id}`,
    );
  }
}
