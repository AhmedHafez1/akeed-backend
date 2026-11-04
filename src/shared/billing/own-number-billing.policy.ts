/**
 * What one send costs and which pool pays for it.
 *
 * Prepaid costs are displayed credits (1 credit = EGP 1). A stored credit is
 * worth two, so an Akeed-number send reserves one stored credit as it always
 * has, and an own-number send costs half of one. The half is carried in
 * `credit_accounts.spare_credit`: the first of two own-number sends takes a
 * whole stored credit and leaves a spare, the second uses the spare. Charging
 * the first, not the second, means the balance always covers a send before it
 * goes out.
 *
 * Shopify plans count messages instead: the plan's Akeed pool plus a separate
 * own-number pool of {@link ownNumberMultiplier} times its size.
 *
 * A fallback is the Akeed-number retry of an own-number attempt that failed.
 * The merchant already chose to send, so a fallback is never blocked by an
 * empty balance: it charges what is left.
 */

export type SenderKind = 'akeed_system' | 'merchant_own';
export type ChargeRule = 'standard' | 'fallback';
export type BillingPool = 'credits' | 'akeed' | 'own_number';

/** Displayed credits an Akeed-number send costs on prepaid. */
export const AKEED_SEND_DISPLAYED_COST = 2;
/** Displayed credits an own-number send costs on prepaid. */
export const OWN_NUMBER_SEND_DISPLAYED_COST = 1;
/** Own-number messages one fallback takes when the Akeed pool is empty (D4). */
export const FALLBACK_OWN_POOL_COST = 3;

export interface PrepaidPoolSnapshot {
  /** Stored credits not already held: `posted_balance - held_credits`. */
  availableStored: number;
  /** `credit_accounts.spare_credit`, 0 or 1. */
  spare: number;
}

/**
 * - `reserve`: today's Akeed-number hold of one stored credit, settled on the
 *   provider's answer.
 * - `pack`: post one stored credit as `own_number_pack` and leave a spare.
 * - `use_spare`: spend the spare, no ledger row.
 * - `none`: a fallback with nothing left to charge.
 */
export type PrepaidChargeAction = 'reserve' | 'pack' | 'use_spare' | 'none';

export type PrepaidCharge =
  | {
      allowed: true;
      pool: 'credits';
      cost: 0 | 1 | 2;
      action: PrepaidChargeAction;
    }
  | { allowed: false; reason: 'INSUFFICIENT_CREDITS' };

export function decidePrepaidCharge(params: {
  sender: SenderKind;
  rule: ChargeRule;
  snapshot: PrepaidPoolSnapshot;
}): PrepaidCharge {
  const stored = Math.max(params.snapshot.availableStored, 0);
  const spare = params.snapshot.spare === 1 ? 1 : 0;
  if (params.rule === 'fallback') {
    if (stored >= 1)
      return { allowed: true, pool: 'credits', cost: 2, action: 'reserve' };
    if (spare)
      return { allowed: true, pool: 'credits', cost: 1, action: 'use_spare' };
    return { allowed: true, pool: 'credits', cost: 0, action: 'none' };
  }
  if (params.sender === 'merchant_own') {
    if (spare)
      return { allowed: true, pool: 'credits', cost: 1, action: 'use_spare' };
    if (stored >= 1)
      return { allowed: true, pool: 'credits', cost: 1, action: 'pack' };
    return { allowed: false, reason: 'INSUFFICIENT_CREDITS' };
  }
  if (stored >= 1)
    return { allowed: true, pool: 'credits', cost: 2, action: 'reserve' };
  return { allowed: false, reason: 'INSUFFICIENT_CREDITS' };
}

/**
 * The spare and ledger movement that returns one displayed credit: a spare
 * comes back, and two spares become one stored credit again.
 */
export function refundOwnNumberCredit(spare: number): {
  spare: 0 | 1;
  reversal: boolean;
} {
  return spare === 1
    ? { spare: 0, reversal: true }
    : { spare: 1, reversal: false };
}

/** The spare left after an own-number charge. */
export function spareAfterCharge(
  action: 'pack' | 'use_spare',
  spare: number,
): 0 | 1 {
  if (action === 'pack') {
    if (spare !== 0) throw new Error('A pack opens only with no spare');
    return 1;
  }
  if (spare !== 1) throw new Error('No spare to use');
  return 0;
}

/** Displayed credits a balance holds: stored credits are worth two each. */
export function displayedBalance(snapshot: PrepaidPoolSnapshot): number {
  return (
    Math.max(snapshot.availableStored, 0) * 2 + (snapshot.spare === 1 ? 1 : 0)
  );
}

/** Displayed credits the next send costs, for gates that run before a claim. */
export function nextSendDisplayedCost(sender: SenderKind): number {
  return sender === 'merchant_own'
    ? OWN_NUMBER_SEND_DISPLAYED_COST
    : AKEED_SEND_DISPLAYED_COST;
}

/**
 * Stored credits `messages` sends need, for gates that count stored credits.
 * Own-number sends cost half a stored credit each, and a spare pays for one.
 */
export function storedCreditsForMessages(
  messages: number,
  sender: SenderKind,
  spare: number,
): number {
  if (sender !== 'merchant_own') return messages;
  return Math.ceil(Math.max(messages - (spare === 1 ? 1 : 0), 0) / 2);
}

export interface PeriodicPoolSnapshot {
  akeedUsed: number;
  akeedLimit: number;
  ownUsed: number;
  ownLimit: number;
}

export type PeriodicCharge =
  | { allowed: true; pool: 'akeed' | 'own_number'; cost: number }
  | { allowed: false; reason: 'plan_limit_reached' };

export function decidePeriodicCharge(params: {
  sender: SenderKind;
  rule: ChargeRule;
  snapshot: PeriodicPoolSnapshot;
}): PeriodicCharge {
  const akeedLeft = Math.max(
    params.snapshot.akeedLimit - params.snapshot.akeedUsed,
    0,
  );
  const ownLeft = Math.max(
    params.snapshot.ownLimit - params.snapshot.ownUsed,
    0,
  );
  if (params.rule === 'fallback') {
    if (akeedLeft >= 1) return { allowed: true, pool: 'akeed', cost: 1 };
    return {
      allowed: true,
      pool: 'own_number',
      cost: Math.min(FALLBACK_OWN_POOL_COST, ownLeft),
    };
  }
  if (params.sender === 'merchant_own') {
    if (ownLeft >= 1) return { allowed: true, pool: 'own_number', cost: 1 };
    // D11: the number is healthy, so keep sending from it on the Akeed pool.
    if (akeedLeft >= 1) return { allowed: true, pool: 'akeed', cost: 1 };
    return { allowed: false, reason: 'plan_limit_reached' };
  }
  if (akeedLeft >= 1) return { allowed: true, pool: 'akeed', cost: 1 };
  return { allowed: false, reason: 'plan_limit_reached' };
}

/**
 * Plan usage as the merchant should see it for the next send: both pools while
 * the next send would go from their number, the Akeed pool alone otherwise.
 */
export function periodicUsageForNextSend(
  snapshot: PeriodicPoolSnapshot,
  sender: SenderKind,
): { used: number; limit: number } {
  return sender === 'merchant_own'
    ? {
        used: snapshot.akeedUsed + snapshot.ownUsed,
        limit: snapshot.akeedLimit + snapshot.ownLimit,
      }
    : { used: snapshot.akeedUsed, limit: snapshot.akeedLimit };
}

/** Whether the prepaid charge on a dispatch went through a credit reservation. */
export function usesCreditReservation(dispatch: {
  billingPool: BillingPool | null;
  billingCost: number | null;
}): boolean {
  return dispatch.billingPool == null || dispatch.billingCost === 2;
}

/** Whether a prepaid dispatch holds an own-number charge that a refund returns. */
export function holdsSpareCharge(dispatch: {
  billingPool: BillingPool | null;
  billingCost: number | null;
  billingRefundedAt: string | null;
}): boolean {
  return (
    dispatch.billingPool === 'credits' &&
    dispatch.billingCost === 1 &&
    dispatch.billingRefundedAt == null
  );
}
