import { sql, type SQL } from 'drizzle-orm';
import { orders, verifications } from '../schema';
import type { NeedsActionReason } from '../../../shared/verification/verification-needs-action';

export interface NeedsActionContext {
  /** ISO instant the "read but no reply" delay is measured against. */
  now: string;
  /** How long a read message may go unanswered before the merchant is asked. */
  escalationDelayMinutes: number;
}

/**
 * The one definition of "this order needs the merchant".
 *
 * Returns the reason for the first rule that matches, or NULL:
 * 1. `delivery_failed`: WhatsApp reported the message undeliverable.
 * 2. `no_reply_after_follow_up`: still unanswered after the reminder went out.
 * 3. `read_no_reply`: read, unanswered, and older than the escalation delay.
 * 4. `no_reply`: escalated to no-reply without a reminder or a read receipt.
 *
 * Test sends never need action. Failures caused by the plan or billing are
 * deliberately left out: the usage bar asks for that fix, not each row.
 */
export function needsActionReasonSql(
  context: NeedsActionContext,
): SQL<NeedsActionReason | null> {
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
    WHEN ${verifications.status} IN ('sent', 'delivered', 'read', 'no_reply')
      AND ${verifications.followUpSentAt} IS NOT NULL
      THEN 'no_reply_after_follow_up'
    WHEN ${verifications.status} IN ('read', 'no_reply')
      AND ${verifications.readAt} IS NOT NULL
      AND ${verifications.readAt} <= ${context.now}::timestamptz - make_interval(mins => ${context.escalationDelayMinutes}::int)
      THEN 'read_no_reply'
    WHEN ${verifications.status} = 'no_reply' THEN 'no_reply'
    ELSE NULL
  END`;
}
