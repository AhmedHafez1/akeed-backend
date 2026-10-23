/**
 * Automatic cancellation of unanswered COD orders.
 *
 * When a store has it switched on, an order is canceled in its store when it
 * reaches `no_reply`, at the no-reply delay the merchant set. The escalation
 * already waits for quiet hours to end, so the cancellation needs no timing
 * rule of its own. It runs only when the customer demonstrably had the
 * chance to answer: every message of the sequence was delivered, nothing came
 * back from their number, and the merchant did not keep the order. Anything
 * Akeed could not prove (an undelivered or blocked reminder, a delivery that
 * was never reported) pauses the cancellation instead: running out of credits
 * or plan allowance is never a reason to cancel.
 */

/** `cancellation_source` of an order Akeed canceled on its own. */
export const AUTOMATIC_CANCELLATION_SOURCE = 'automatic_no_reply';

/** Shown to the merchant and written to the store's staff note. */
export const AUTO_CANCEL_REASON_TEXT =
  'No response after confirmation attempts';

export const AUTO_CANCEL_STATUSES = [
  'scheduled',
  'paused',
  'in_progress',
  'awaiting_platform',
  'succeeded',
  'failed',
  'skipped',
  'stopped',
] as const;

export type AutoCancelStatus = (typeof AUTO_CANCEL_STATUSES)[number];

/** Statuses a reply, an exclusion or a disabled setting can still stop. */
export const AUTO_CANCEL_STOPPABLE_STATUSES = [
  'scheduled',
  'paused',
] as const satisfies readonly AutoCancelStatus[];

/**
 * Statuses in which the store has been, or is being, asked to cancel. A
 * customer reply that arrives now is flagged for the merchant instead of
 * changing the order.
 */
export const AUTO_CANCEL_COMMITTED_STATUSES = [
  'in_progress',
  'awaiting_platform',
  'succeeded',
] as const satisfies readonly AutoCancelStatus[];

export const AUTO_CANCEL_EVENTS = [
  'scheduled',
  'paused',
  'resumed',
  'excluded',
  'included',
  'stopped',
  'platform_checked',
  'dispatch_started',
  'platform_pending',
  'retry_scheduled',
  'succeeded',
  'failed',
  'skipped',
  'late_reply',
] as const;

export type AutoCancelEvent = (typeof AUTO_CANCEL_EVENTS)[number];

export type AutoCancelSkipReason =
  | 'disabled'
  | 'test_order'
  | 'excluded'
  | 'not_no_reply'
  | 'already_resolved'
  | 'customer_replied';

export type AutoCancelPauseReason =
  | 'initial_not_delivered'
  | 'reminder_blocked'
  | 'reminder_not_delivered';

/** Why a cancellation that was scheduled or paused will not run. */
export type AutoCancelStopReason =
  | 'customer_reply'
  | 'excluded'
  | 'feature_disabled'
  | 'status_changed';

export type AutoCancelDecision =
  | { kind: 'schedule'; dueAt: Date }
  | { kind: 'pause'; reason: AutoCancelPauseReason }
  | { kind: 'skip'; reason: AutoCancelSkipReason };

/** Everything the decision reads, gathered by the caller. */
export interface AutoCancelFacts {
  enabled: boolean;
  isTestOrder: boolean;
  status: string;
  confirmedAt?: string | null;
  canceledAt?: string | null;
  merchantCanceledAt?: string | null;
  excludedAt?: string | null;
  customerLastMessageAt?: string | null;
  /** First delivery or read receipt of the confirmation message. */
  initialDeliveredAt?: string | null;
  /** A reminder was sent, or its send was refused or failed. */
  followUpAttempted: boolean;
  /** `follow_up_skipped` / `follow_up_failed` recorded on the row. */
  followUpBlockedReason?: string | null;
  /** First delivery or read receipt of the reminder. */
  followUpDeliveredAt?: string | null;
}

function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * Whether this order may be canceled automatically. When it may, it is due
 * `now`: the moment it reached no reply.
 */
export function evaluateAutoCancel(
  facts: AutoCancelFacts,
  now: Date,
): AutoCancelDecision {
  if (!facts.enabled) return { kind: 'skip', reason: 'disabled' };
  if (facts.isTestOrder) return { kind: 'skip', reason: 'test_order' };
  if (facts.excludedAt) return { kind: 'skip', reason: 'excluded' };
  if (facts.confirmedAt || facts.canceledAt || facts.merchantCanceledAt) {
    return { kind: 'skip', reason: 'already_resolved' };
  }
  if (facts.status !== 'no_reply') {
    return { kind: 'skip', reason: 'not_no_reply' };
  }
  if (facts.customerLastMessageAt) {
    return { kind: 'skip', reason: 'customer_replied' };
  }

  if (timeOf(facts.initialDeliveredAt) === null) {
    return { kind: 'pause', reason: 'initial_not_delivered' };
  }
  if (facts.followUpBlockedReason) {
    return { kind: 'pause', reason: 'reminder_blocked' };
  }
  if (facts.followUpAttempted && timeOf(facts.followUpDeliveredAt) === null) {
    return { kind: 'pause', reason: 'reminder_not_delivered' };
  }
  return { kind: 'schedule', dueAt: now };
}

/**
 * The cancellation time shown on an order that has not reached `no_reply`
 * yet: its escalation time, when the same rules would let it run. Display
 * only; the decision is taken again when the escalation fires.
 */
export function projectAutoCancelAt(
  facts: Omit<AutoCancelFacts, 'status'>,
  escalationDueAt: Date,
): Date | null {
  const decision = evaluateAutoCancel(
    { ...facts, status: 'no_reply' },
    escalationDueAt,
  );
  return decision.kind === 'schedule' ? decision.dueAt : null;
}

/** Back-off before a retryable store failure is tried again. */
export const AUTO_CANCEL_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  8 * 60_000,
  30 * 60_000,
] as const;

/** Attempts at the store, including the first, before the order fails. */
export const AUTO_CANCEL_MAX_ATTEMPTS = AUTO_CANCEL_RETRY_DELAYS_MS.length + 1;

/** The wait before attempt `attempts + 1`, or null when none is left. */
export function autoCancelRetryDelayMs(attempts: number): number | null {
  if (attempts >= AUTO_CANCEL_MAX_ATTEMPTS) return null;
  return AUTO_CANCEL_RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? null;
}

/** How long a worker owns a claimed cancellation before another may resume it. */
export const AUTO_CANCEL_LEASE_MS = 5 * 60_000;

/** How long the store may take to confirm an asynchronous cancellation. */
export const AUTO_CANCEL_CONFIRMATION_TIMEOUT_MS = 30 * 60_000;

/** How long a paused cancellation keeps being re-checked. */
export const AUTO_CANCEL_PAUSE_RECHECK_MS = 7 * 24 * 60 * 60_000;
