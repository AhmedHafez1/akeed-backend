import type {
  ChargeRule,
  PeriodicPoolSnapshot,
  SenderKind,
} from './own-number-billing.policy';

/**
 * Why a shipping message was refused before it was sent. `no_allowance`: every
 * pool that could pay has nothing left. `allowance_low`: a pool has messages
 * left, but sending would eat into the part kept for confirmations.
 */
export type ShippingReserveRefusal = 'allowance_low' | 'no_allowance';

export type ShippingCharge =
  | { allowed: true; pool: 'akeed' | 'own_number'; cost: 1 }
  | { allowed: false; reason: ShippingReserveRefusal };

/**
 * The messages of a pool kept for confirmations: a tenth of its allowance,
 * rounded up (Basic: 30 of 300). Integer maths, so 300 never becomes 31.
 */
export function shippingReserveFor(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.ceil(Math.floor(limit) / 10);
}

function left(used: number, limit: number): number {
  return Math.max(limit - used, 0);
}

/**
 * Whether a shipping message may be charged, and to which pool. Confirmations
 * come first: a pool pays only while it keeps its reserve after this message.
 *
 * - An own-number send uses its own pool, then spills over to the Akeed pool,
 *   each under its own reserve.
 * - An Akeed-number send, a fallback included, uses the Akeed pool only.
 */
export function decideShippingCharge(params: {
  sender: SenderKind;
  chargeRule?: ChargeRule;
  snapshot: PeriodicPoolSnapshot;
}): ShippingCharge {
  const { snapshot } = params;
  const akeedLeft = left(snapshot.akeedUsed, snapshot.akeedLimit);
  const ownLeft = left(snapshot.ownUsed, snapshot.ownLimit);
  const akeedKeeps = akeedLeft - 1 >= shippingReserveFor(snapshot.akeedLimit);
  const ownNumberSend =
    params.sender === 'merchant_own' && params.chargeRule !== 'fallback';
  if (ownNumberSend) {
    const ownKeeps =
      ownLeft >= 1 && ownLeft - 1 >= shippingReserveFor(snapshot.ownLimit);
    if (ownKeeps) return { allowed: true, pool: 'own_number', cost: 1 };
    if (akeedLeft >= 1 && akeedKeeps)
      return { allowed: true, pool: 'akeed', cost: 1 };
    return {
      allowed: false,
      reason:
        ownLeft === 0 && akeedLeft === 0 ? 'no_allowance' : 'allowance_low',
    };
  }
  if (akeedLeft >= 1 && akeedKeeps)
    return { allowed: true, pool: 'akeed', cost: 1 };
  return {
    allowed: false,
    reason: akeedLeft === 0 ? 'no_allowance' : 'allowance_low',
  };
}
