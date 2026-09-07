import type { VerificationStatus } from '../interfaces/verification.interface';

/**
 * Platform-neutral verification lifecycle vocabulary.
 *
 * Every guard, projection and retry decision in the verification core reads
 * these lists. They were previously re-declared in five places (two SQL
 * builders, two service-level `Set` literals and an inline `||` chain) and had
 * already diverged. Import from here instead of restating them.
 */

/**
 * Statuses that must never be overwritten once reached. A customer's confirm
 * or cancel reply is the final word on a verification.
 */
export const TERMINAL_STATUSES: VerificationStatus[] = [
  'confirmed',
  'canceled',
];

/**
 * Statuses that webhook delivery/read/failed events must not overwrite.
 * A superset of {@link TERMINAL_STATUSES} that additionally stops a late
 * provider webhook from reverting a `no_reply` escalation. Customer button
 * replies may still override `no_reply`.
 */
export const WEBHOOK_PROTECTED_STATUSES: VerificationStatus[] = [
  ...TERMINAL_STATUSES,
  'no_reply',
];

/**
 * `metadata.reason` values on a `failed` verification that a merchant may
 * retry. Each represents a condition the merchant can resolve (top up the
 * plan, reactivate the source, settle billing) rather than a permanent defect.
 */
export const RETRYABLE_VERIFICATION_REASONS = [
  'plan_limit_reached',
  'integration_inactive',
  'billing_not_active',
  'provider_not_accepted',
  // The provider call threw or returned no message id, so nothing proves a
  // message went out. Omitting this stranded the row permanently: merchant
  // retry and event redelivery both match `metadata.reason` against this list,
  // so a `failed`/`provider_outcome_unknown` verification could never be
  // reopened. The `last_sent_at IS NULL` guard on
  // `reopenRetryableInitialFailure` is what stops a send that *did* reach the
  // provider from being repeated.
  'provider_outcome_unknown',
] as const;

/**
 * `webhook_events.last_error` values that mean the order was accepted but the
 * verification was withheld for a resolvable reason, so the event can be
 * re-dispatched once the merchant fixes the cause.
 */
export const BLOCKED_EVENT_REASONS = [
  'integration_inactive',
  'billing_not_active',
  'plan_limit_reached',
  'auto_verify_disabled',
  'onboarding_incomplete',
] as const;

/**
 * Skip reasons returned by the send path that should project the verification
 * to `failed` rather than leaving it `pending`.
 */
export const SEND_FAILURE_REASONS = [
  'integration_inactive',
  'billing_not_active',
  'missing_linked_integration',
  'source_identity_mismatch',
] as const;

/** Statuses at which the automation pipeline stops scheduling further work. */
export const AUTOMATION_FINAL_STATUSES: VerificationStatus[] = [
  ...TERMINAL_STATUSES,
  'failed',
  'expired',
  'no_reply',
];

export function isTerminalStatus(
  status: string | null | undefined,
): status is 'confirmed' | 'canceled' {
  return status === 'confirmed' || status === 'canceled';
}

export function isRetryableVerificationReason(
  reason: string | null | undefined,
): boolean {
  return (
    reason != null &&
    (RETRYABLE_VERIFICATION_REASONS as readonly string[]).includes(reason)
  );
}

export function isBlockedEventReason(
  reason: string | null | undefined,
): boolean {
  return (
    reason != null &&
    (BLOCKED_EVENT_REASONS as readonly string[]).includes(reason)
  );
}

export function isSendFailureReason(
  reason: string | null | undefined,
): boolean {
  return (
    reason != null &&
    (SEND_FAILURE_REASONS as readonly string[]).includes(reason)
  );
}
