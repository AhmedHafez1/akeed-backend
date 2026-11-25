import { NO_WHATSAPP_SEND_REASON } from '../verification/delivery-failure.policy';
import type { ShippingFailureReason } from './shipping-notification.types';

/** What a send attempt returned, as far as the shipping record cares. */
export interface ShippingSendResult {
  status:
    | 'sent'
    | 'sent_untracked'
    | 'failed'
    | 'plan_limit_reached'
    | 'skipped'
    | 'outcome_unknown'
    | 'recovery_pending';
  reason?: string;
}

/** Store or billing states in which the store has nothing to pay with. */
const NO_ALLOWANCE_REASONS = new Set([
  'no_allowance',
  'plan_limit_reached',
  'billing_not_active',
  'INSUFFICIENT_CREDITS',
  'CREDIT_DEBT_OUTSTANDING',
]);

/**
 * The failure a send outcome writes onto a pending shipping record, or null
 * when the record should stay as it is: the message went out (the ledger
 * already wrote `sent`), is still being retried or recovered, or another
 * worker holds it. A refused send is never retried.
 */
export function shippingFailureForOutcome(
  result: ShippingSendResult,
): ShippingFailureReason | null {
  switch (result.status) {
    case 'sent':
    case 'sent_untracked':
    case 'recovery_pending':
    case 'outcome_unknown':
      return null;
    case 'failed':
      return result.reason === NO_WHATSAPP_SEND_REASON
        ? 'not_on_whatsapp'
        : 'send_failed';
    case 'plan_limit_reached':
      return 'no_allowance';
    case 'skipped':
      if (
        result.reason === 'dispatch_in_progress' ||
        result.reason === 'recovery_finished'
      )
        return null;
      if (result.reason === 'verification_closed') return 'order_cancelled';
      if (result.reason === 'no_phone') return 'no_phone';
      if (result.reason === 'template_unavailable')
        return 'template_unavailable';
      if (result.reason && NO_ALLOWANCE_REASONS.has(result.reason))
        return 'no_allowance';
      return 'send_failed';
  }
}
