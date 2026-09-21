import { signQuoteToken, verifyQuoteToken } from './quote-token';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-09-21T10:00:00Z');
const claims = {
  batchId: '5f0f8a52-7c5e-4b0e-9d0e-1a2b3c4d5e6f',
  orders: 970,
  balance: 2_300,
  expiresAt: NOW.getTime() + 600_000,
};

describe('quote token', () => {
  it('round-trips the claims', () => {
    expect(
      verifyQuoteToken(signQuoteToken(claims, SECRET), SECRET, NOW),
    ).toEqual({ ok: true, claims });
  });

  it('keeps a null balance', () => {
    const token = signQuoteToken({ ...claims, balance: null }, SECRET);
    expect(verifyQuoteToken(token, SECRET, NOW)).toMatchObject({
      ok: true,
      claims: { balance: null },
    });
  });

  it('refuses a tampered payload or another secret', () => {
    const token = signQuoteToken(claims, SECRET);
    const [, signature] = token.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({
        b: claims.batchId,
        n: 1,
        bal: 99_999,
        exp: claims.expiresAt,
      }),
    ).toString('base64url')}.${signature}`;
    expect(verifyQuoteToken(forged, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verifyQuoteToken(token, 'b'.repeat(32), NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('expires after its 10 minutes', () => {
    const token = signQuoteToken(claims, SECRET);
    expect(verifyQuoteToken(token, SECRET, new Date(claims.expiresAt))).toEqual(
      { ok: false, reason: 'expired' },
    );
  });

  it.each(['', 'abc', 'a.b.c', '.sig'])(
    'refuses malformed token %p',
    (token) => {
      expect(verifyQuoteToken(token, SECRET, NOW).ok).toBe(false);
    },
  );
});
