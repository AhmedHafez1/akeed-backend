import { createHash, randomBytes } from 'crypto';

/**
 * Tokens of the EasyOrders install (US-06-02, contract record sections 1, 6).
 *
 * Two different 256-bit values per install: the one-time callback token, and
 * the webhook URL token that later decides the tenant of every webhook. Both
 * travel only in URL paths and only their SHA-256 is stored, so a lookup is
 * by hash and one token resolves to exactly one row or to nothing.
 */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HINT_LENGTH = 6;

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
 * The last characters of a webhook URL token. The seller sees the whole URL
 * in their EasyOrders dashboard; the hint lets them find the right row there.
 */
export function installTokenHint(token: string): string {
  return token.slice(-HINT_LENGTH);
}
