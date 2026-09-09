import type { CreditDenialCode } from './credit-eligibility';
import {
  DEFAULT_BILLING_PLAN_ID,
  isBillingPlanId,
  resolveIncludedVerificationsLimit,
  type BillingPlanId,
} from './billing-plan';
import { getBillingPeriodStart, getBillingPeriodEnd } from './billing-period';
import { isBillingStatusActive } from '../utils/billing.util';

export interface EntitlementIdentity {
  orgId: string;
  id: string;
}

export interface EntitlementSource extends EntitlementIdentity {
  platformType: string;
  isActive: boolean | null;
  billingStatus: string | null;
  billingPlanId: string | null;
  billingActivatedAt: string | null;
}

export type EntitlementDenialReason =
  | 'missing_linked_integration'
  | 'source_identity_mismatch'
  | 'integration_inactive'
  | 'billing_not_active';

export interface BillingManagement {
  mode: 'shopify' | 'manual';
  canManageBilling: boolean;
}

export function getBillingManagement(
  source: Pick<EntitlementSource, 'platformType' | 'isActive'>,
): BillingManagement {
  return {
    mode: source.platformType === 'shopify' ? 'shopify' : 'manual',
    canManageBilling:
      source.platformType === 'shopify' && source.isActive === true,
  };
}

export interface EntitlementSnapshot {
  allowed: boolean;
  reason: EntitlementDenialReason | null;
  planId: BillingPlanId | null;
  includedLimit: number;
  periodStart: string;
  periodEnd: string;
}

export interface EntitlementAvailability {
  available: boolean;
  consumedCount: number;
  includedLimit: number;
  reason:
    | EntitlementDenialReason
    | CreditDenialCode
    | 'plan_limit_reached'
    | null;
}

export function resolveEntitlement(
  source: EntitlementSource | undefined,
  identity: EntitlementIdentity,
  now = new Date(),
): EntitlementSnapshot {
  const validPlan =
    source?.billingPlanId && isBillingPlanId(source.billingPlanId)
      ? source.billingPlanId
      : null;
  const planId =
    validPlan ??
    (source?.platformType === 'shopify' ? DEFAULT_BILLING_PLAN_ID : null);
  const periodStart = getBillingPeriodStart(source?.billingActivatedAt, now);
  let reason: EntitlementDenialReason | null = null;
  if (!source) reason = 'missing_linked_integration';
  else if (source.id !== identity.id || source.orgId !== identity.orgId)
    reason = 'source_identity_mismatch';
  else if (!source.isActive) reason = 'integration_inactive';
  else if (source.platformType === 'shopify') {
    if (!isBillingStatusActive(source.billingStatus))
      reason = 'billing_not_active';
  } else if (
    source.platformType !== 'standalone' &&
    (source.billingStatus?.trim().toLowerCase() !== 'not_required' ||
      !validPlan ||
      !source.billingActivatedAt ||
      !Number.isFinite(new Date(source.billingActivatedAt).getTime()))
  ) {
    reason = 'billing_not_active';
  }
  return {
    allowed: reason === null,
    reason,
    planId,
    includedLimit: planId ? resolveIncludedVerificationsLimit(planId) : 0,
    periodStart,
    periodEnd: getBillingPeriodEnd(periodStart),
  };
}
