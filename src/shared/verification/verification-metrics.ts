/**
 * Pure arithmetic behind the embedded dashboard's numbers.
 *
 * The counts come from one SQL aggregate; everything here is a function of
 * those counts, so every edge (no sends, all failed, an empty period) is
 * covered by unit tests without a database.
 */

export interface OverviewCounts {
  /** Verifications whose first message was accepted by the provider. */
  sent: number;
  /** Of those, how many WhatsApp reported delivered. */
  delivered: number;
  /** Of those, how many WhatsApp reported read (or were answered). */
  read: number;
  /** Every confirmed verification in the period, sent or not. */
  confirmed: number;
  /** Confirmed verifications that had a recorded send (customer or merchant). */
  confirmedAfterSend: number;
  /** Of those, the ones the customer confirmed by replying. */
  customerConfirmedAfterSend: number;
  /** Customer cancellations in the period (merchant cancels excluded). */
  customerCanceled: number;
  /** Customer cancellations that had a recorded send. */
  customerCanceledAfterSend: number;
}

export interface FunnelStep {
  count: number;
  /** Share of sent, 0–100 with one decimal; null when nothing was sent. */
  percent_of_sent: number | null;
}

export interface MessageFunnel {
  sent: FunnelStep;
  delivered: FunnelStep;
  read: FunnelStep;
  replied: FunnelStep;
  confirmed: number;
  customer_canceled: number;
  no_reply_yet: number;
}

/**
 * An outcome as a percentage of sends.
 *
 * Null rather than zero when nothing was sent, so a new shop reads "—" instead
 * of an alarming 0%. Clamped to [0, 100]: the numerator is restricted to sent
 * rows by the query, and the clamp only guards against data defects.
 */
export function rateOfSent(outcome: number, sent: number): number | null {
  if (!Number.isFinite(sent) || sent <= 0) return null;
  const ratio = (Math.max(outcome, 0) / sent) * 100;
  return Number(Math.min(ratio, 100).toFixed(1));
}

export function buildMessageFunnel(counts: OverviewCounts): MessageFunnel {
  const sent = Math.max(counts.sent, 0);
  const cap = (value: number) => Math.min(Math.max(value, 0), sent);
  const confirmed = cap(counts.customerConfirmedAfterSend);
  const customerCanceled = cap(counts.customerCanceledAfterSend);
  const replied = cap(confirmed + customerCanceled);
  const step = (count: number): FunnelStep => ({
    count,
    percent_of_sent: rateOfSent(count, sent),
  });

  return {
    sent: step(sent),
    delivered: step(cap(counts.delivered)),
    read: step(cap(counts.read)),
    replied: step(replied),
    confirmed,
    customer_canceled: Math.min(customerCanceled, replied - confirmed),
    no_reply_yet: sent - replied,
  };
}

export type UsageState = 'ok' | 'warning' | 'exhausted';

/** Share of the plan used; the credits bar appears from 80% and turns critical at 100%. */
export function resolveUsage(
  used: number,
  limit: number,
): { used: number; limit: number; percent: number; state: UsageState } {
  const safeUsed = Math.max(used, 0);
  const safeLimit = Math.max(limit, 0);
  if (safeLimit === 0) {
    return { used: safeUsed, limit: safeLimit, percent: 0, state: 'ok' };
  }
  const percent = Math.min(Math.floor((safeUsed / safeLimit) * 100), 100);
  const state: UsageState =
    safeUsed >= safeLimit ? 'exhausted' : percent >= 80 ? 'warning' : 'ok';
  return { used: safeUsed, limit: safeLimit, percent, state };
}
