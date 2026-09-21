import type { CreditDenialCode } from './credit-eligibility';
import type { CreditSummary } from '../ports/credit-accounting.port';
import {
  DEFAULT_BILLING_PLAN_ID,
  isBillingPlanId,
  isOneTimeBillingPlan,
  resolveIncludedVerificationsLimit,
  type BillingPlanId,
} from './billing-plan';
import {
  getBillingPeriodStart,
  getBillingPeriodEnd,
  getOneTimePeriodStart,
} from './billing-period';
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
  /** `null` for a one-time plan: its allowance never resets. */
  periodEnd: string | null;
}

export interface EntitlementAvailability {
  available: boolean;
  consumedCount: number;
  includedLimit: number;
  /** Prepaid-credit sources: the balance this availability was read from. */
  credits?: CreditSummary;
  reason:
    | EntitlementDenialReason
    | CreditDenialCode
    | 'plan_limit_reached'
    | null;
}

/** Which accounting system bills a source's new sends. */
export type UsageAccountingMode = 'prepaid_credit' | 'periodic_plan';

/**
 * `accountingMode` decides whether the legacy plan columns govern access. A
 * prepaid-credit source is gated by its credit balance, so the plan columns
 * are ignored there. A periodic-plan source is gated by them, and that
 * includes a Standalone source while credit billing is switched off: skipping
 * the check by platform let a frozen or unprovisioned Standalone source
 * reserve monthly usage. The default is the strict periodic rule, so a caller
 * that does not know the mode fails closed.
 */
export function resolveEntitlement(
  source: EntitlementSource | undefined,
  identity: EntitlementIdentity,
  now = new Date(),
  accountingMode: UsageAccountingMode = 'periodic_plan',
): EntitlementSnapshot {
  const validPlan =
    source?.billingPlanId && isBillingPlanId(source.billingPlanId)
      ? source.billingPlanId
      : null;
  const planId =
    validPlan ??
    (source?.platformType === 'shopify' ? DEFAULT_BILLING_PLAN_ID : null);
  const oneTime = isOneTimeBillingPlan(planId);
  const periodStart = oneTime
    ? getOneTimePeriodStart(source?.billingActivatedAt)
    : getBillingPeriodStart(source?.billingActivatedAt, now);
  let reason: EntitlementDenialReason | null = null;
  if (!source) reason = 'missing_linked_integration';
  else if (source.id !== identity.id || source.orgId !== identity.orgId)
    reason = 'source_identity_mismatch';
  else if (!source.isActive) reason = 'integration_inactive';
  else if (source.platformType === 'shopify') {
    if (!isBillingStatusActive(source.billingStatus))
      reason = 'billing_not_active';
  } else if (
    accountingMode === 'periodic_plan' &&
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
    periodEnd: oneTime ? null : getBillingPeriodEnd(periodStart),
  };
}
