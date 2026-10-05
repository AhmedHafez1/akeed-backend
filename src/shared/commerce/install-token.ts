import { createHash, randomBytes } from 'crypto';

/**
 * Tokens of a store install that travel in URL paths: the one-time callback
 * token and the webhook URL token that later decides the tenant of every
 * delivery. Each is a 256-bit value and only its SHA-256 is stored, so a
 * lookup is by hash and one token resolves to exactly one row or to nothing.
 *
 * Every spoke with an install link uses these, so the token shape cannot
 * differ between providers.
 */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
