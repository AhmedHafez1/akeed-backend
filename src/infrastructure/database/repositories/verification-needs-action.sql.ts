import { sql, type SQL } from 'drizzle-orm';
import { orders, verifications } from '../schema';
import { AUTOMATIC_CANCELLATION_SOURCE } from '../../../shared/verification/auto-cancel.policy';
import type { NeedsActionReason } from '../../../shared/verification/verification-needs-action';

/**
 * The one definition of "this order needs the merchant".
 *
 * Returns the reason for the first rule that matches, or NULL:
 * -. `late_reply_after_auto_cancel`: Akeed canceled the order in its store
 *    and the customer wrote afterwards; contact them (Akeed does not store
 *    the message text).
 * 0. `no_whatsapp`: the customer number cannot receive WhatsApp; call them.
 * 1. `delivery_failed`: WhatsApp reported the message undeliverable.
 * 2. `send_failed`: any other failure: the message never went out (no
 *    credits, plan limit, source inactive, provider error).
 * -. `customer_replied`: the customer wrote without a clear confirm or
 *    cancel; contact them. It also stops the automatic cancellation.
 * -. `auto_cancel_failed`: the automatic cancellation failed at the store;
 *    the order is still open there.
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
  // query drizzle rewrites every typed column to the root table's alias. A
  // plain select leaves typed columns unqualified, so a typed column of the
  // outer row stays outside a subquery whose table has a column of that name
  // (`id IN (SELECT ...)`): inside it, "id" would be the subquery's own.
  return sql<NeedsActionReason | null>`CASE
    WHEN EXISTS (
      SELECT 1 FROM ${orders} test_order
      WHERE test_order.id = ${verifications.orderId}
        AND (test_order.is_test = true OR test_order.external_order_id LIKE 'akeed-test-%')
    ) THEN NULL
    WHEN ${verifications.status} = 'canceled'
      AND ${verifications.cancellationSource} = ${AUTOMATIC_CANCELLATION_SOURCE}
      AND ${verifications.id} IN (
        SELECT late_auto_cancel.verification_id
        FROM verification_auto_cancellations late_auto_cancel
        WHERE late_auto_cancel.late_reply_at IS NOT NULL
      )
      THEN 'late_reply_after_auto_cancel'
    WHEN ${verifications.status} = 'no_whatsapp' THEN 'no_whatsapp'
    WHEN ${verifications.status} = 'failed'
      AND ${verifications.metadata}->>'reason' = 'provider_delivery_failed'
      THEN 'delivery_failed'
    WHEN ${verifications.status} = 'failed' THEN 'send_failed'
    WHEN ${verifications.status} IN ('sent', 'delivered', 'read', 'no_reply')
      AND ${verifications.customerLastMessageAt} IS NOT NULL
      THEN 'customer_replied'
    WHEN ${verifications.status} = 'no_reply'
      AND ${verifications.id} IN (
        SELECT failed_auto_cancel.verification_id
        FROM verification_auto_cancellations failed_auto_cancel
        WHERE failed_auto_cancel.status = 'failed'
      )
      THEN 'auto_cancel_failed'
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
