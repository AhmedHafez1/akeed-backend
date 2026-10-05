import { randomBytes, randomInt } from 'crypto';

/**
 * What only the WooCommerce install adds to the shared install tokens
 * (`shared/commerce/install-token.ts`; US-07-01 contract record, sections 1,
 * 6 and 7): the install reference and the webhook secret.
 */
const REFERENCE_PATTERN = /^[1-9][0-9]{14}$/;
const WEBHOOK_SECRET_BYTES = 32;

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
