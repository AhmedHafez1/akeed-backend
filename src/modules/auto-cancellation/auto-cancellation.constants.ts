/**
 * BullMQ queue for automatic cancellation of unanswered orders.
 *
 *   1. EXECUTE — check the store and cancel one order whose time has come.
 *   2. CONFIRM — ask the store whether an accepted cancellation finished.
 *   3. SWEEP   — every few minutes, pick up due rows whose job was lost,
 *                re-check paused ones, resume abandoned claims and poll the
 *                store for cancellations it has not confirmed.
 *
 * The `verification_auto_cancellations` row is the source of truth; a job
 * carries its id only, and running one twice does nothing the second time.
 */

export const AUTO_CANCELLATION_QUEUE = 'auto-cancellation';

export const AUTO_CANCELLATION_EXECUTE_JOB = 'auto_cancel.execute';
export const AUTO_CANCELLATION_CONFIRM_JOB = 'auto_cancel.confirm';
export const AUTO_CANCELLATION_SWEEP_JOB = 'auto_cancel.sweep';
export const AUTO_CANCELLATION_SWEEP_SCHEDULER = 'auto-cancellation-sweep';
export const AUTO_CANCELLATION_SWEEP_EVERY_MS = 5 * 60_000;

/** Rows of each kind one sweep handles. */
export const AUTO_CANCELLATION_SWEEP_BATCH = 200;

/** First and later waits before asking the store whether it finished. */
export const AUTO_CANCELLATION_CONFIRM_DELAY_MS = 30_000;
export const AUTO_CANCELLATION_CONFIRM_REPEAT_MS = 2 * 60_000;

export interface AutoCancellationJobPayload {
  autoCancellationId: string;
}

/**
 * One job per row, kind and due time: a repeat of the same schedule joins
 * the first, a new schedule (a retry, a quiet-hours move) gets its own.
 */
export function autoCancellationJobId(
  autoCancellationId: string,
  kind: 'execute' | 'confirm',
  at: Date,
): string {
  return `auto-cancel-${autoCancellationId}-${kind}-${at.getTime()}`;
}
