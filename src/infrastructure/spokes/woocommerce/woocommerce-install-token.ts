import { createHash, randomBytes, randomInt } from 'crypto';

/**
 * Tokens of the WooCommerce install (US-07-01 contract record, sections 1, 6
 * and 7).
 *
 * Two different 256-bit values per install: the one-time callback token, and
 * the webhook URL token that later decides the tenant of every delivery.
 * Both travel only in URL paths and only their SHA-256 is stored, so a lookup
 * is by hash and one token resolves to exactly one row or to nothing.
 */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REFERENCE_PATTERN = /^[1-9][0-9]{14}$/;
const WEBHOOK_SECRET_BYTES = 32;

export function generateInstallToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashInstallToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Strict shape check, so a malformed path segment never reaches the database. */
export function isWellFormedInstallToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * The value sent as `user_id`: 15 decimal digits, not a secret. Digits only
 * and no leading zero, because whether the store returns it as a JSON string
 * or a JSON number is unknown (finding 1.8) and 15 digits survive both.
 */
export function generateInstallReference(): string {
  return `${randomInt(1, 10)}${String(randomInt(0, 10_000_000)).padStart(7, '0')}${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
}

/** Compares after converting to text, so a string and a number both match. */
export function matchesInstallReference(
  value: unknown,
  reference: string,
): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return REFERENCE_PATTERN.test(text) && text === reference;
}

/** One per install, used by both webhooks; it leaves Akeed only in their creation. */
export function generateWebhookSecret(): string {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');
}
