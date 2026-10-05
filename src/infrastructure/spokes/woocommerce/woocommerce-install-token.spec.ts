import {
  generateInstallReference,
  generateWebhookSecret,
  matchesInstallReference,
} from './woocommerce-install-token';

describe('WooCommerce install tokens', () => {
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
