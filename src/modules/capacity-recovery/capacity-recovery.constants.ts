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

/** Orders read per page. */
export const CAPACITY_RECOVERY_BATCH = 50;
/** Pages one RECOVER run reads before handing over to a continuation. */
export const CAPACITY_RECOVERY_PAGES_PER_RUN = 10;
/**
 * How long a reopened order may stay unsent with nothing scheduled before
 * recovery treats the handoff as interrupted and blocks it again.
 */
export const CAPACITY_RESUME_GRACE_MS = 15 * 60_000;
/** Orgs one SWEEP run enqueues. */
export const CAPACITY_RECOVERY_SWEEP_ORGS = 500;

/** The last order a run looked at, in candidate order. */
export interface CapacityRecoveryCursor {
  createdAt: string;
  id: string;
}

export interface CapacityRecoveryJobPayload {
  orgId: string;
  trigger: CapacityRecoveryTrigger;
  /** A continuation starts after this order; any other run from the oldest. */
  after?: CapacityRecoveryCursor;
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

/**
 * The continuation of one run. It cannot share the org's key, which the
 * running job still holds, and a retried run adds the same one, not a second.
 */
export function capacityRecoveryContinuationDedupeId(
  orgId: string,
  jobId: string,
): string {
  return `capacity-recovery-${orgId}-after-${jobId}`;
}
