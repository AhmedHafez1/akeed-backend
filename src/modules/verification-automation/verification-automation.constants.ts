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
 *                            cancels (US-08-07b). Attempted once, never retried.
 *   5. UNRESOLVED_REPLY_NUDGE — one free-form nudge after a typed reply Akeed
 *                            could not read (US-08-07c). Attempted once.
 */

export const VERIFICATION_AUTOMATION_QUEUE_NAME = 'verification-automation';

export enum VerificationAutomationJobType {
  INITIAL_SEND = 'verification.initial_send',
  FOLLOW_UP = 'verification.follow_up',
  ESCALATE_NO_REPLY = 'verification.escalate_no_reply',
  ACKNOWLEDGMENT = 'verification.acknowledgment',
  UNRESOLVED_REPLY_NUDGE = 'verification.unresolved_reply_nudge',
}

export interface VerificationAutomationJobPayload {
  verificationId: string;
  orgId: string;
  scheduledAt: string;
  /**
   * The customer's message an acknowledgment or a nudge answers: when it was
   * sent and, for an acknowledgment, what it said. Never its text.
   */
  reply?: {
    repliedAt: string;
    intent?: 'confirmed' | 'canceled';
  };
}
