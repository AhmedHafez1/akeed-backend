import {
  generateInstallReference,
  generateInstallToken,
  generateWebhookSecret,
  hashInstallToken,
  isWellFormedInstallToken,
  matchesInstallReference,
} from './woocommerce-install-token';

describe('WooCommerce install tokens', () => {
  it('generates 256-bit base64url tokens that differ every time', () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => generateInstallToken()),
    );

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(isWellFormedInstallToken(token)).toBe(true);
    }
  });

  it('stores a token only as its SHA-256', () => {
    const token = generateInstallToken();

    expect(hashInstallToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInstallToken(token)).toBe(hashInstallToken(token));
    expect(hashInstallToken(token)).not.toContain(token);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'short',
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(42)}/`,
    `${'a'.repeat(42)}.`,
    `${'a'.repeat(42)}=`,
  ])('refuses the malformed token %p', (value) => {
    expect(isWellFormedInstallToken(value)).toBe(false);
  });

  it('generates a 15-digit reference that survives a JSON number', () => {
    for (let index = 0; index < 200; index++) {
      const reference = generateInstallReference();

      expect(reference).toMatch(/^[1-9][0-9]{14}$/);
      expect(Number.isSafeInteger(Number(reference))).toBe(true);
      expect(String(JSON.parse(reference))).toBe(reference);
    }
  });

  it('matches the reference as a string or as a number, and nothing else', () => {
    const reference = '482910573629104';

    expect(matchesInstallReference(reference, reference)).toBe(true);
    expect(matchesInstallReference(482910573629104, reference)).toBe(true);
    expect(matchesInstallReference('482910573629105', reference)).toBe(false);
    expect(matchesInstallReference(` ${reference}`, reference)).toBe(false);
    expect(matchesInstallReference(`${reference}.0`, reference)).toBe(false);
    expect(matchesInstallReference([reference], reference)).toBe(false);
    expect(matchesInstallReference({ reference }, reference)).toBe(false);
    expect(matchesInstallReference(undefined, reference)).toBe(false);
    expect(matchesInstallReference(null, reference)).toBe(false);
    expect(matchesInstallReference(true, reference)).toBe(false);
  });

  it('generates a 32-byte webhook secret', () => {
    const secret = generateWebhookSecret();

    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(generateWebhookSecret()).not.toBe(secret);
  });
});
