import type { BillingPlanId } from './billing-plan';
import { isOneTimeBillingPlan } from './billing-plan';
import { isBillingStatusActive } from '../utils/billing.util';

/**
 * When a merchant is told that sending capacity is running out, and what they
 * are told to do about it. Pure rules: the service claims and sends.
 */

export type UsageAlertKind = 'plan_usage' | 'credit_balance';
export type PlanUsageAlertLevel = '80' | '95' | '100';
export type CreditAlertLevel = 'low' | 'depleted';
export type UsageAlertLevel = PlanUsageAlertLevel | CreditAlertLevel;
export type UsageAlertEmailStatus = 'pending' | 'sent' | 'skipped' | 'failed';

/** What unblocks sending: a bigger plan, more credits, or the next period. */
export type CapacityAction = 'upgrade' | 'recharge' | 'wait_reset';

const PLAN_USAGE_LEVELS: readonly {
  level: PlanUsageAlertLevel;
  percent: number;
}[] = [
  { level: '80', percent: 80 },
  { level: '95', percent: 95 },
  { level: '100', percent: 100 },
];

/**
 * The credit alert's dedupe key. A credit balance has no period, so the open
 * row is the incident: it blocks a repeat until the balance recovers and the
 * row is resolved.
 */
export const CREDIT_ALERT_CYCLE_KEY = 'incident';

/** The plan with the largest allowance: nothing to upgrade to. */
export const TOP_BILLING_PLAN_ID: BillingPlanId = 'business';

/**
 * Every plan level the usage has reached, lowest first. A jump from 79% to
 * 100% reaches all three; each is recorded so none fires later in the period,
 * and only the highest is emailed.
 */
export function planUsageAlertLevels(
  used: number,
  limit: number,
): PlanUsageAlertLevel[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return PLAN_USAGE_LEVELS.filter(
    ({ percent }) => used * 100 >= limit * percent,
  ).map(({ level }) => level);
}

/**
 * Every credit level the balance has reached, lowest first. `low` is at or
 * under the merchant-facing threshold; `depleted` is under one credit, when
 * nothing can be sent. A threshold of 0 turns `low` off.
 */
export function creditAlertLevels(
  availableCredits: number,
  lowBalanceThreshold: number,
): CreditAlertLevel[] {
  const levels: CreditAlertLevel[] = [];
  if (lowBalanceThreshold > 0 && availableCredits <= lowBalanceThreshold) {
    levels.push('low');
  }
  if (availableCredits < 1) levels.push('depleted');
  return levels;
}

/** The credit levels that are open but no longer reached, to resolve. */
export function recoveredCreditLevels(
  availableCredits: number,
  lowBalanceThreshold: number,
): CreditAlertLevel[] {
  const reached = creditAlertLevels(availableCredits, lowBalanceThreshold);
  return (['low', 'depleted'] as const).filter(
    (level) => !reached.includes(level),
  );
}

/**
 * A plan alert is sent once per billing period. A one-time plan has a single
 * period that never rolls over, so its key is marked to never collide with a
 * rolling period that happens to start on the same day.
 */
export function planUsageCycleKey(
  planId: BillingPlanId | null,
  periodStart: string,
): string {
  return isOneTimeBillingPlan(planId) ? `one_time:${periodStart}` : periodStart;
}

/** The highest of the levels, which is the one the email describes. */
export function highestLevel<T extends UsageAlertLevel>(levels: T[]): T | null {
  return levels.length > 0 ? levels[levels.length - 1] : null;
}

/**
 * What the merchant can do once capacity is short. Credits are recharged. A
 * one-time allowance never renews, so the only way on is a plan. The top plan
 * cannot be upgraded, so it waits for its next period. Any other plan can
 * upgrade now or wait for the reset date shown beside the action.
 */
export function capacityAction(params: {
  mode: 'plan' | 'credits';
  planId: BillingPlanId | null;
}): CapacityAction {
  if (params.mode === 'credits') return 'recharge';
  if (params.planId === TOP_BILLING_PLAN_ID) return 'wait_reset';
  return 'upgrade';
}

/**
 * The plan the merchant can buy again to start a fresh period now, beside the
 * action above. Only a recurring paid plan renews: credits are recharged, and
 * a one-time allowance cannot be claimed twice.
 */
export function renewablePlanId(params: {
  mode: 'plan' | 'credits';
  planId: BillingPlanId | null;
}): BillingPlanId | null {
  if (params.mode !== 'plan' || !params.planId) return null;
  return isOneTimeBillingPlan(params.planId) ? null : params.planId;
}

/**
 * The plan a store can renew right now: its recurring paid plan, while that
 * subscription is live. A canceled, frozen or declined plan is subscribed to
 * again, not renewed. The banner offer, the plan list and the billing
 * endpoint all read this one rule.
 */
export function renewableSubscriptionPlanId(params: {
  planId: BillingPlanId | null;
  billingStatus: string | null | undefined;
}): BillingPlanId | null {
  if (!isBillingStatusActive(params.billingStatus)) return null;
  return renewablePlanId({ mode: 'plan', planId: params.planId });
}
