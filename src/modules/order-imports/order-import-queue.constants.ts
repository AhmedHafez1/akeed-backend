/**
 * The bulk-import work queue.
 *
 * Separate from `webhook-processing` so a long commit can never sit in front
 * of a merchant's manual order, and so its concurrency is tuned on its own.
 */
export const ORDER_IMPORT_QUEUE = 'order-import';

export const ORDER_IMPORT_COMMIT_JOB = 'import.commit';

export interface OrderImportCommitJob {
  batchId: string;
  orgId: string;
}

/**
 * One commit job per batch, forever.
 *
 * BullMQ refuses a second job with an id it already holds, so a double-click
 * is a no-op at the queue as well as at the conditional UPDATE that precedes
 * it. The two guards are independent on purpose: the database is the
 * authority, the job id is the cheap path.
 */
export function orderImportCommitJobId(batchId: string): string {
  return `import-commit-${batchId}`;
}
