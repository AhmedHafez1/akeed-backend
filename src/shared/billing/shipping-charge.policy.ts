import type {
  ChargeRule,
  PeriodicPoolSnapshot,
  SenderKind,
} from './own-number-billing.policy';

/** Every pool that could pay for a shipping message has nothing left. */
export type ShippingChargeRefusal = 'no_allowance';

export type ShippingCharge =
  | { allowed: true; pool: 'akeed' | 'own_number'; cost: 1 }
  | { allowed: false; reason: ShippingChargeRefusal };

function left(used: number, limit: number): number {
  return Math.max(limit - used, 0);
}

/**
 * Whether a shipping message may be charged, and to which pool. It uses the
 * same allowance as confirmations, with nothing held back for them: the
 * merchant already sees the low-allowance warnings.
 *
 * - An own-number send uses its own pool, then the Akeed pool.
 * - An Akeed-number send, a fallback included, uses the Akeed pool only.
 */
export function decideShippingCharge(params: {
  sender: SenderKind;
  chargeRule?: ChargeRule;
  snapshot: PeriodicPoolSnapshot;
}): ShippingCharge {
  const { snapshot } = params;
  const akeedLeft = left(snapshot.akeedUsed, snapshot.akeedLimit);
  const ownNumberSend =
    params.sender === 'merchant_own' && params.chargeRule !== 'fallback';
  if (ownNumberSend && left(snapshot.ownUsed, snapshot.ownLimit) >= 1)
    return { allowed: true, pool: 'own_number', cost: 1 };
  if (akeedLeft >= 1) return { allowed: true, pool: 'akeed', cost: 1 };
  return { allowed: false, reason: 'no_allowance' };
}
