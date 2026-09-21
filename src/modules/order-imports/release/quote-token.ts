import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a start quote stays valid. */
export const QUOTE_TOKEN_TTL_MS = 10 * 60_000;

/**
 * What the merchant saw when they decided to start: the batch, how many
 * customers, and the balance (credits, or plan slots) at that moment.
 */
export interface QuoteTokenClaims {
  batchId: string;
  orders: number;
  balance: number | null;
  expiresAt: number;
}

export type QuoteTokenCheck =
  | { ok: true; claims: QuoteTokenClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signQuoteToken(
  claims: QuoteTokenClaims,
  secret: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      b: claims.batchId,
      n: claims.orders,
      bal: claims.balance,
      exp: claims.expiresAt,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Checks the signature before trusting any claim. */
export function verifyQuoteToken(
  token: string,
  secret: string,
  now: Date,
): QuoteTokenCheck {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined)
    return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(payload, secret));
  const received = Buffer.from(signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return { ok: false, reason: 'signature' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const raw = decoded as Record<string, unknown>;
  if (
    typeof raw?.b !== 'string' ||
    typeof raw.n !== 'number' ||
    typeof raw.exp !== 'number' ||
    (raw.bal !== null && typeof raw.bal !== 'number')
  )
    return { ok: false, reason: 'malformed' };
  if (raw.exp <= now.getTime()) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    claims: {
      batchId: raw.b,
      orders: raw.n,
      balance: raw.bal,
      expiresAt: raw.exp,
    },
  };
}
