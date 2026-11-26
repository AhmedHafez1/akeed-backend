import { randomBytes } from 'node:crypto';

/**
 * The random ending of a shipment's Track order short link. 16 random bytes
 * (128 bits) written base64url, so the code cannot be guessed and is safe in
 * a URL path. The code is generated once per shipment and stored; a retry
 * reuses the stored one.
 */
const CODE_BYTES = 16;
const CODE_PATTERN = /^[A-Za-z0-9_-]{22,43}$/;

export function generateShippingTrackingCode(): string {
  return randomBytes(CODE_BYTES).toString('base64url');
}

/** A cheap shape check run before any database lookup. */
export function isWellFormedShippingTrackingCode(
  value: unknown,
): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}
