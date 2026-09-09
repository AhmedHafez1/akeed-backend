import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paymob processed-callback HMAC.
 *
 * Paymob does not sign the request body. It signs a concatenation of twenty
 * named values from `obj`, in one documented order, and sends the digest as a
 * `hmac` query parameter. So this cannot be replaced by hashing the raw body or
 * by canonicalising JSON: reordering keys, reformatting numbers or adding
 * fields must all still verify, and only the twenty values matter.
 *
 * https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback
 */

/**
 * The signed fields, in Paymob's documented order. Written as dotted paths so
 * the order is one reviewable list rather than a concatenation expression.
 */
export const PAYMOB_HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

/**
 * Fields Paymob may legitimately omit or send as null, which then contribute an
 * empty string.
 *
 * Everything else is structurally required. Treating a missing `amount_cents`
 * or `success` as `''` would let a truncated body verify against a signature
 * computed over the same truncation, which is exactly the substitution this
 * check exists to prevent.
 */
const OPTIONAL_FIELDS = new Set<string>([
  'owner',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
]);

export class MalformedPaymobCallbackError extends Error {
  constructor(readonly field: string) {
    super(`Paymob callback field ${field} is missing or unusable`);
  }
}

function resolve(obj: Record<string, unknown>, path: string): unknown {
  if (path === 'order.id') {
    // `order` arrives as the nested object on a processed callback and as a
    // bare id elsewhere. Both mean the same order.
    const order = obj.order;
    return order !== null && typeof order === 'object'
      ? (order as Record<string, unknown>).id
      : order;
  }
  if (path.startsWith('source_data.')) {
    const source = obj.source_data;
    return source !== null && typeof source === 'object'
      ? (source as Record<string, unknown>)[path.slice('source_data.'.length)]
      : undefined;
  }
  return obj[path];
}

/** Serializes one value exactly as Paymob does when it signs. */
export function normalizePaymobValue(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    if (OPTIONAL_FIELDS.has(field)) return '';
    throw new MalformedPaymobCallbackError(field);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // Exponent form would change the signed bytes for the same amount, and a
    // non-finite amount is not an amount.
    const text = String(value);
    if (!Number.isFinite(value) || /[eE]/.test(text))
      throw new MalformedPaymobCallbackError(field);
    return text;
  }
  if (typeof value === 'string') return value;
  throw new MalformedPaymobCallbackError(field);
}

/** The exact string Paymob signs, in Paymob's order, with no separators. */
export function buildPaymobHmacSource(obj: Record<string, unknown>): string {
  return PAYMOB_HMAC_FIELDS.map((field) =>
    normalizePaymobValue(resolve(obj, field), field),
  ).join('');
}

const DIGEST_PATTERN = /^[a-f0-9]{128}$/;

/**
 * Verifies a callback digest in constant time.
 *
 * The shape check runs first so a malformed parameter is rejected before any
 * crypto, and so `timingSafeEqual` -- which throws on unequal lengths, leaking
 * the comparison it was chosen to hide -- can only ever see two 128-byte
 * buffers.
 */
export function verifyPaymobHmac(
  obj: Record<string, unknown>,
  received: unknown,
  secret: string,
): boolean {
  if (typeof received !== 'string' || !DIGEST_PATTERN.test(received))
    return false;
  const expected = createHmac('sha512', secret)
    .update(buildPaymobHmacSource(obj), 'utf8')
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/** Test-only helper so fixtures can be signed with a known secret. */
export function signPaymobPayload(
  obj: Record<string, unknown>,
  secret: string,
): string {
  return createHmac('sha512', secret)
    .update(buildPaymobHmacSource(obj), 'utf8')
    .digest('hex');
}
