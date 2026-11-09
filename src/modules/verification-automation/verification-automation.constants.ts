/**
 * BullMQ queue + job constants for the verification automation worker.
 *
 * The automation worker handles delayed lifecycle transitions for a
 * verification record:
 *   1. INITIAL_SEND        — send the first WhatsApp template after
 *                            `integrations.send_delay_minutes` (delayed orders).
 *   2. FOLLOW_UP           — re-send the WhatsApp template after
 *                            `integrations.follow_up_delay_minutes` if the
 *                            customer has not yet responded.
 *   3. ESCALATE_NO_REPLY   — mark the verification as `no_reply` after
 *                            `integrations.escalation_delay_minutes` and tag
 *                            the Shopify order.
 *   4. ACKNOWLEDGMENT      — one free-form reply after a customer confirms or
 *                            cancels. Attempted once, never retried.
 *   5. UNRESOLVED_REPLY_NUDGE — one free-form nudge after a typed reply Akeed
 *                            could not read. Attempted once.
 *   6. CHANGE_REQUEST_RECONFIRMATION — the merchant's updated confirmation for
 *                            an open change request, built from the order's
 *                            current details; held until quiet hours end.
 */

export const VERIFICATION_AUTOMATION_QUEUE_NAME = 'verification-automation';

export enum VerificationAutomationJobType {
  CHANGE_REQUEST_ACKNOWLEDGMENT_SWEEP = 'verification.change_request_acknowledgment_sweep',
  CHANGE_REQUEST_EFFECTS = 'verification.change_request_effects',
  SENDER_RETRY = 'verification.sender_retry',
  SENDER_FALLBACK = 'verification.sender_fallback',
  SENDER_RECOVERY_SWEEP = 'verification.sender_recovery_sweep',
  INITIAL_SEND = 'verification.initial_send',
  FOLLOW_UP = 'verification.follow_up',
  ESCALATE_NO_REPLY = 'verification.escalate_no_reply',
  ACKNOWLEDGMENT = 'verification.acknowledgment',
  UNRESOLVED_REPLY_NUDGE = 'verification.unresolved_reply_nudge',
  CHANGE_REQUEST_RECONFIRMATION = 'verification.change_request_reconfirmation',
}

import type { MerchantReplySender } from '../../shared/messaging/merchant-reply-sender';

export interface VerificationAutomationJobPayload {
  changeRequestId?: string;
  dispatchId?: string;
  verificationId: string;
  orgId: string;
  scheduledAt: string;
  /**
   * The confirmation cycle a reminder or escalation was scheduled for. A job
   * of an earlier cycle does nothing once an updated confirmation started a
   * new one. Absent on jobs queued before cycles existed: cycle 1.
   */
  confirmationCycle?: number;
  /**
   * An updated confirmation: the request it is for and the merchant's
   * attempt. A job of an earlier attempt does nothing.
   */
  reconfirmation?: { changeRequestId: string; attempt: number };
  /**
   * The customer's message an acknowledgment or a nudge answers: when it was
   * sent and, for an acknowledgment, what it said. Never its text.
   */
  reply?: {
    repliedAt: string;
    intent?: 'confirmed' | 'canceled';
    receivingSender?: MerchantReplySender;
  };
}
