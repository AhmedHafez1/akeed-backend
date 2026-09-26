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

/** One paced release tick for an organization (US-04.6-07). */
export const ORDER_IMPORT_RELEASE_JOB = 'import.release';

export interface OrderImportReleaseJob {
  orgId: string;
}

/**
 * The organization's release scheduler id. One per org, whatever the number
 * of releasing batches, so every batch shares one rate budget.
 */
export function orderImportReleaseSchedulerId(orgId: string): string {
  return `import-release-${orgId}`;
}

/**
 * How long a committed batch may sit held before `import.expire` withdraws it.
 * The modal commits and starts in one action, so a batch only waits here when
 * its start failed or was interrupted; it is a cleanup bound, not a merchant
 * setting.
 */
export const ORDER_IMPORT_HELD_BATCH_TTL_HOURS = 24;

/** Withdraws batches whose start window lapsed (AC9). */
export const ORDER_IMPORT_EXPIRE_JOB = 'import.expire';
export const ORDER_IMPORT_EXPIRE_SCHEDULER = 'import-expire';
export const ORDER_IMPORT_EXPIRE_EVERY_MS = 60 * 60_000;

/**
 * The daily retention job (US-04.6-09): deletes expired drafts and, 90 days
 * after a commit, drops the rows' raw cells and normalized order while keeping
 * outcome, issues, order link and row number.
 */
export const ORDER_IMPORT_PURGE_JOB = 'import.purge';
export const ORDER_IMPORT_PURGE_SCHEDULER = 'import-purge';
export const ORDER_IMPORT_PURGE_EVERY_MS = 24 * 60 * 60_000;
export const ORDER_IMPORT_RETENTION_DAYS = 90;
