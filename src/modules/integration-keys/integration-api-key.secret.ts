import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * The integration API key format (US-05-01):
 *
 *   ak_live_<8 lowercase alphanumerics>_<43 base64url chars>
 *   └──────── prefix (non-secret) ────┘ └── 32 random bytes ──┘
 *
 * The prefix is stored in clear and is how the guard finds the key; only the
 * SHA-256 of the 32 secret bytes is stored. The prefix has a fixed length, so
 * the `_` that base64url may contain never makes a key ambiguous.
 */
export const INTEGRATION_API_KEY_PREFIX_LABEL = 'ak_live_';

const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PREFIX_RANDOM_LENGTH = 8;
const SECRET_BYTES = 32;
const SECRET_ENCODED_LENGTH = 43;

/** Longest header value worth parsing; anything longer is malformed. */
export const INTEGRATION_API_KEY_MAX_LENGTH = 128;

const KEY_PATTERN = /^(ak_live_[a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

/** Compared against when no key has the prefix, so both paths hash and compare. */
const UNKNOWN_KEY_HASH = '0'.repeat(64);

export interface GeneratedIntegrationApiKey {
  prefix: string;
  /** The full key, shown to the merchant once and never stored. */
  plaintext: string;
  keyHash: string;
}

export interface ParsedIntegrationApiKey {
  prefix: string;
  secret: Buffer;
}

export function generateIntegrationApiKeyPrefix(): string {
  let suffix = '';
  for (let index = 0; index < PREFIX_RANDOM_LENGTH; index++)
    suffix += PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)];
  return `${INTEGRATION_API_KEY_PREFIX_LABEL}${suffix}`;
}

export function hashIntegrationApiKeySecret(secret: Buffer): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateIntegrationApiKey(): GeneratedIntegrationApiKey {
  const prefix = generateIntegrationApiKeyPrefix();
  const secret = randomBytes(SECRET_BYTES);
  return {
    prefix,
    plaintext: `${prefix}_${secret.toString('base64url')}`,
    keyHash: hashIntegrationApiKeySecret(secret),
  };
}

/**
 * Strict parse: the exact format, and a secret that decodes to 32 bytes and
 * re-encodes to the same text, so one secret has exactly one spelling.
 */
export function parseIntegrationApiKey(
  value: string,
): ParsedIntegrationApiKey | null {
  if (value.length > INTEGRATION_API_KEY_MAX_LENGTH) return null;
  const match = KEY_PATTERN.exec(value);
  if (!match) return null;
  const [, prefix, encoded] = match;
  if (encoded.length !== SECRET_ENCODED_LENGTH) return null;
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length !== SECRET_BYTES) return null;
  if (secret.toString('base64url') !== encoded) return null;
  return { prefix, secret };
}

/**
 * Timing-safe check of a presented secret against a stored hash. Pass
 * `storedHash: null` when no key had the prefix: the comparison still runs,
 * so an unknown prefix costs the same as a wrong secret.
 */
export function matchesIntegrationApiKeyHash(
  secret: Buffer,
  storedHash: string | null,
): boolean {
  const expected = Buffer.from(storedHash ?? UNKNOWN_KEY_HASH, 'utf8');
  const received = Buffer.from(hashIntegrationApiKeySecret(secret), 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received) && storedHash !== null;
}
