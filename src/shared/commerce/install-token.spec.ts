import {
  generateInstallToken,
  hashInstallToken,
  isWellFormedInstallToken,
} from './install-token';

describe('install tokens', () => {
  it('generates 256-bit base64url tokens that never repeat', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateInstallToken()),
    );

    expect(tokens.size).toBe(200);
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
    expect(hashInstallToken(token)).not.toBe(
      hashInstallToken(generateInstallToken()),
    );
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
});
