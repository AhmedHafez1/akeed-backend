import type { CommerceCancellationInspection } from '../commerce/commerce-outcome';
import type { VerificationStatus } from '../interfaces/verification.interface';

/**
 * Customer change requests ("Request a change").
 *
 * A customer waiting to confirm a COD order may ask for a change instead of
 * confirming or canceling. The request is an attention task kept apart from
 * the verification's outcome: the verification stays awaiting confirmation,
 * which already keeps it out of the shippable (confirmed) orders, while the
 * request stops the reminder, the no-reply escalation and the automatic
 * cancellation. Akeed never edits the order.
 *
 * The request is resolved only by an outcome: the customer's own Confirm or
 * Cancel from the current cycle, the merchant confirming or canceling after
 * contacting the customer, or a successful updated confirmation that starts
 * a new cycle. An ordinary order update is never proof of resolution.
 */

/** Every verification and dispatch written before cycles existed is cycle 1. */
export const LEGACY_CONFIRMATION_CYCLE = 1;

export const CHANGE_REQUEST_STATUSES = ['open', 'resolved'] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

export const CHANGE_REQUEST_RESOLUTIONS = [
  'customer_confirmed',
  'customer_canceled',
  'merchant_confirmed',
  'merchant_canceled',
  'reconfirmation_sent',
] as const;
export type ChangeRequestResolution =
  (typeof CHANGE_REQUEST_RESOLUTIONS)[number];

export const CHANGE_REQUEST_EVENTS = [
  'opened',
  'repeat_ignored',
  'resolved',
  'reconfirmation_failed',
] as const;
export type ChangeRequestEvent = (typeof CHANGE_REQUEST_EVENTS)[number];

export type ChangeRequestActorKind = 'customer' | 'merchant' | 'system';

/**
 * Side effects committed with a transition and carried out afterwards by
 * their own workers: nothing reaches a provider inside the transaction.
 */
export const CHANGE_REQUEST_EFFECT_KINDS = [
  'customer_acknowledgment',
  'merchant_email',
  'platform_marker_set',
  'platform_marker_clear',
] as const;
export type ChangeRequestEffectKind =
  (typeof CHANGE_REQUEST_EFFECT_KINDS)[number];

export const CHANGE_REQUEST_EFFECT_STATUSES = [
  'pending',
  'in_progress',
  'done',
  'skipped',
  'failed',
] as const;
export type ChangeRequestEffectStatus =
  (typeof CHANGE_REQUEST_EFFECT_STATUSES)[number];

/** Effects a newly opened request owes. */
export const CHANGE_REQUEST_OPEN_EFFECTS = [
  'customer_acknowledgment',
  'merchant_email',
  'platform_marker_set',
] as const satisfies readonly ChangeRequestEffectKind[];

/**
 * Statuses in which the order still awaits the customer's confirmation. The
 * no-reply statuses are included because a customer's answer still
 * overrides them (`CUSTOMER_REPLY_OVERRIDABLE_STATUSES`).
 */
export const CHANGE_REQUEST_OPENABLE_STATUSES = [
  'sent',
  'delivered',
  'read',
  'no_reply',
  'no_whatsapp',
] as const satisfies readonly VerificationStatus[];

/** `cancellation_source` of an order the merchant canceled after contact. */
export const MERCHANT_CHANGE_REQUEST_CANCELLATION_SOURCE =
  'merchant_change_request';

/** Stop reason recorded on an automatic cancellation a request stopped. */
export const CHANGE_REQUEST_AUTO_CANCEL_STOP_REASON = 'change_requested';

/** Skip reason of a reminder or escalation an open request held back. */
export const CHANGE_REQUEST_OPEN_REASON = 'change_request_open';

/**
 * What Akeed knows about whether the goods left. `unknown` is never treated
 * as verified unshipped; it only does not block a request.
 */
export type ShippingState = 'shipped' | 'not_shipped' | 'unknown';

/**
 * The store's view read for an automatic cancellation, as shipping evidence.
 * Only a fulfilled order is known shipped. A fulfillment in progress, an
 * unsupported source or a failed read leaves it unknown.
 */
export function shippingStateFromInspection(
  inspection: CommerceCancellationInspection | null | undefined,
): ShippingState {
  if (!inspection) return 'unknown';
  if (inspection.state === 'not_cancellable')
    return inspection.reason === 'fulfilled' ? 'shipped' : 'unknown';
  if (inspection.state === 'cancellable') return 'not_shipped';
  return 'unknown';
}

export type ChangeRequestRejectReason =
  | 'not_awaiting_confirmation'
  | 'known_shipped'
  | 'stale_cycle'
  | 'merchant_canceled'
  | 'auto_cancel_committed'
  | 'test_order';

export interface ChangeRequestOpenFacts {
  status: string;
  merchantCanceledAt?: string | null;
  isTestOrder: boolean;
  /** The verification's current cycle. */
  currentCycle: number;
  /** The cycle of the message the customer answered. */
  eventCycle: number;
  shipping: ShippingState;
  /** The automatic cancellation reached, or is reaching, the store. */
  autoCancelCommitted: boolean;
  /** An open request already exists for this verification. */
  hasOpenRequest: boolean;
}

export type ChangeRequestOpenDecision =
  | { kind: 'open' }
  | { kind: 'already_open' }
  | { kind: 'reject'; reason: ChangeRequestRejectReason };

/**
 * Whether a customer's change request may open. A stale cycle is rejected
 * before anything else, so a retired button never reports anything about
 * the current order; a repeat of the open request is answered before the
 * status checks, so it never looks like a rejection.
 */
export function evaluateChangeRequestOpen(
  facts: ChangeRequestOpenFacts,
): ChangeRequestOpenDecision {
  if (facts.eventCycle !== facts.currentCycle)
    return { kind: 'reject', reason: 'stale_cycle' };
  if (facts.hasOpenRequest) return { kind: 'already_open' };
  if (facts.isTestOrder) return { kind: 'reject', reason: 'test_order' };
  if (facts.merchantCanceledAt)
    return { kind: 'reject', reason: 'merchant_canceled' };
  if (
    !(CHANGE_REQUEST_OPENABLE_STATUSES as readonly string[]).includes(
      facts.status,
    )
  )
    return { kind: 'reject', reason: 'not_awaiting_confirmation' };
  if (facts.autoCancelCommitted)
    return { kind: 'reject', reason: 'auto_cancel_committed' };
  if (facts.shipping === 'shipped')
    return { kind: 'reject', reason: 'known_shipped' };
  return { kind: 'open' };
}

/** The resolution a customer's answer gives an open request. */
export function customerResolutionOf(
  intent: 'confirmed' | 'canceled',
): ChangeRequestResolution {
  return intent === 'confirmed' ? 'customer_confirmed' : 'customer_canceled';
}

/**
 * Metadata keys of the previous cycle's reminder and escalation. A fresh
 * cycle starts without them, so the new reminder and the automatic
 * cancellation decide from the new messages only.
 */
export const CYCLE_SCOPED_METADATA_KEYS = [
  'follow_up_due_at',
  'follow_up_skipped',
  'follow_up_skipped_at',
  'follow_up_failed',
  'follow_up_failed_at',
  'escalation_skipped',
  'escalation_skipped_at',
] as const;
