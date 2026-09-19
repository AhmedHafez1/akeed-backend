import { randomBytes } from 'node:crypto';

/**
 * Crockford base32: no I, L, O or U, so a code read aloud or retyped from a
 * printed order number (`IMP-<code>-<row>`) cannot be confused.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const SHORT_CODE_LENGTH = 6;

/**
 * A random six-character batch code. 32^6 ≈ 1.07 billion values; uniqueness per
 * organization is enforced by the database, and the caller retries on the rare
 * collision.
 */
export function generateShortCode(
  random: (size: number) => Buffer = randomBytes,
): string {
  // 32 divides 256, so taking each byte modulo 32 has no bias.
  const bytes = random(SHORT_CODE_LENGTH);
  let code = '';
  for (let index = 0; index < SHORT_CODE_LENGTH; index++) {
    code += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return code;
}
