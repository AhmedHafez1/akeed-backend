/**
 * BullMQ queue for resuming orders blocked by sending capacity.
 *
 *   1. RECOVER — send one org's blocked orders while capacity lasts. Enqueued
 *                after a credit purchase, a plan activation or upgrade, and
 *                by the sweep.
 *   2. SWEEP   — every few minutes, enqueue RECOVER for each org with blocked
 *                orders. It covers the allowance reset, which has no event of
 *                its own, staff credit adjustments and any trigger that was
 *                lost.
 */

export const CAPACITY_RECOVERY_QUEUE = 'capacity-recovery';

export const CAPACITY_RECOVERY_RECOVER_JOB = 'capacity.recover';
export const CAPACITY_RECOVERY_SWEEP_JOB = 'capacity.sweep';
export const CAPACITY_RECOVERY_SWEEP_SCHEDULER = 'capacity-recovery-sweep';
export const CAPACITY_RECOVERY_SWEEP_EVERY_MS = 10 * 60_000;

/** Orders one RECOVER run looks at before handing over to the next run. */
export const CAPACITY_RECOVERY_BATCH = 50;
/** Orgs one SWEEP run enqueues. */
export const CAPACITY_RECOVERY_SWEEP_ORGS = 500;

export interface CapacityRecoveryJobPayload {
  orgId: string;
  trigger: CapacityRecoveryTrigger;
}

export type CapacityRecoveryTrigger =
  | 'credit_purchase'
  | 'plan_activated'
  | 'subscription_active'
  | 'sweep'
  | 'continuation';

/** One waiting RECOVER job per org: a repeat trigger joins it. */
export function capacityRecoveryDedupeId(orgId: string): string {
  return `capacity-recovery-${orgId}`;
}
