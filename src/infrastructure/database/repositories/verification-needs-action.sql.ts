import { sql, type SQL } from 'drizzle-orm';
import { orders, verifications } from '../schema';
import type { NeedsActionReason } from '../../../shared/verification/verification-needs-action';

/**
 * The one definition of "this order needs the merchant".
 *
 * Returns the reason for the first rule that matches, or NULL:
 * 1. `delivery_failed`: WhatsApp reported the message undeliverable.
 * 2. `send_failed`: any other failure: the message never went out (no
 *    credits, plan limit, source inactive, provider error).
 * 3. `no_reply_after_follow_up`: escalated to no-reply after the reminder went out.
 * 4. `read_no_reply`: escalated to no-reply after the customer read the message.
 * 5. `no_reply`: escalated to no-reply without a reminder or a read receipt.
 *
 * A no-reply reason is only assigned once the escalation job has moved the
 * row to `no_reply`: a sent reminder or an old read receipt alone still leaves
 * the customer time to answer.
 *
 * Test sends never need action. Every other failed row does, whatever the
 * cause: the order was not confirmed and the merchant must retry or call.
 */
export function needsActionReasonSql(): SQL<NeedsActionReason | null> {
  // The subquery names its own alias and raw columns: inside a relational
  // query drizzle rewrites every typed column to the root table's alias.
  return sql<NeedsActionReason | null>`CASE
    WHEN EXISTS (
      SELECT 1 FROM ${orders} test_order
      WHERE test_order.id = ${verifications.orderId}
        AND (test_order.is_test = true OR test_order.external_order_id LIKE 'akeed-test-%')
    ) THEN NULL
    WHEN ${verifications.status} = 'failed'
      AND ${verifications.metadata}->>'reason' = 'provider_delivery_failed'
      THEN 'delivery_failed'
    WHEN ${verifications.status} = 'failed' THEN 'send_failed'
    WHEN ${verifications.status} = 'no_reply'
      AND ${verifications.followUpSentAt} IS NOT NULL
      THEN 'no_reply_after_follow_up'
    WHEN ${verifications.status} = 'no_reply'
      AND ${verifications.readAt} IS NOT NULL
      THEN 'read_no_reply'
    WHEN ${verifications.status} = 'no_reply' THEN 'no_reply'
    ELSE NULL
  END`;
}
