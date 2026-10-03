/**
 * BullMQ queue for outcomes a store has not taken yet (US-06-04).
 *
 * The `commerce_outcome_syncs` row is the truth; a job only names the row to
 * try again. Only adapters that track synchronization ever produce one.
 */
export const COMMERCE_OUTCOME_SYNC_QUEUE_NAME = 'commerce-outcome-sync';

export const COMMERCE_OUTCOME_SYNC_JOB = 'commerce-outcome.sync';

export interface CommerceOutcomeSyncJobPayload {
  syncId: string;
  orgId: string;
}
