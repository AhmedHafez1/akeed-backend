import { createHash, randomBytes } from 'crypto';
import {
  generateIntegrationApiKey,
  hashIntegrationApiKeySecret,
  matchesIntegrationApiKeyHash,
  parseIntegrationApiKey,
} from './integration-api-key.secret';

describe('integration API key secret', () => {
  it('generates ak_live_ keys whose stored hash is the SHA-256 of 32 random bytes', () => {
    const key = generateIntegrationApiKey();

    expect(key.prefix).toMatch(/^ak_live_[a-z0-9]{8}$/);
    expect(key.plaintext).toMatch(/^ak_live_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key.plaintext.startsWith(`${key.prefix}_`)).toBe(true);
    const parsed = parseIntegrationApiKey(key.plaintext);
    expect(parsed?.prefix).toBe(key.prefix);
    expect(parsed?.secret).toHaveLength(32);
    expect(key.keyHash).toBe(
      createHash('sha256').update(parsed!.secret).digest('hex'),
    );
    // The stored hash never contains the secret text.
    expect(key.keyHash).not.toContain(key.plaintext.slice(17));
  });

  it('never repeats a prefix or a secret across many keys', () => {
    const keys = Array.from({ length: 500 }, generateIntegrationApiKey);

    expect(new Set(keys.map((key) => key.prefix)).size).toBe(500);
    expect(new Set(keys.map((key) => key.plaintext)).size).toBe(500);
  });

  it.each([
    ['empty', ''],
    ['wrong label', `ak_test_abcd1234_${'A'.repeat(43)}`],
    ['uppercase prefix', `ak_live_ABCD1234_${'A'.repeat(43)}`],
    ['short prefix', `ak_live_abc123_${'A'.repeat(43)}`],
    ['short secret', `ak_live_abcd1234_${'A'.repeat(42)}`],
    ['long secret', `ak_live_abcd1234_${'A'.repeat(44)}`],
    ['missing separator', `ak_live_abcd1234${'A'.repeat(43)}`],
    ['extra segment', `ak_live_abcd1234_${'A'.repeat(43)}_x`],
    ['leading space', ` ak_live_abcd1234_${'A'.repeat(43)}`],
    ['trailing newline', `ak_live_abcd1234_${'A'.repeat(43)}\n`],
    ['standard base64', `ak_live_abcd1234_${'A'.repeat(42)}+`],
    // The last char carries 2 unused bits; only one spelling decodes canonically.
    ['non-canonical base64url', `ak_live_abcd1234_${'A'.repeat(42)}B`],
    ['oversized', `ak_live_abcd1234_${'A'.repeat(500)}`],
  ])('rejects a malformed key (%s)', (_name, value) => {
    expect(parseIntegrationApiKey(value)).toBeNull();
  });

  it('matches only the secret that produced the hash', () => {
    const secret = randomBytes(32);
    const hash = hashIntegrationApiKeySecret(secret);

    expect(matchesIntegrationApiKeyHash(secret, hash)).toBe(true);
    expect(matchesIntegrationApiKeyHash(randomBytes(32), hash)).toBe(false);
    expect(matchesIntegrationApiKeyHash(secret, 'f'.repeat(64))).toBe(false);
    expect(matchesIntegrationApiKeyHash(secret, 'short')).toBe(false);
  });

  it('still compares, and fails, when no key had the prefix', () => {
    expect(matchesIntegrationApiKeyHash(randomBytes(32), null)).toBe(false);
  });
});
