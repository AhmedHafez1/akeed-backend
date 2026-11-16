import { hashClaimPhone } from './free-plan-claim-phone';

describe('hashClaimPhone', () => {
  const key = 'k'.repeat(32);

  it('hashes the digits, so formatting does not matter', () => {
    const hash = hashClaimPhone('+20 100 123 4567', key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClaimPhone('201001234567', key)).toBe(hash);
  });

  it('never returns the number itself', () => {
    expect(hashClaimPhone('+201001234567', key)).not.toContain('201001234567');
  });

  it('depends on the key', () => {
    expect(hashClaimPhone('+201001234567', key)).not.toBe(
      hashClaimPhone('+201001234567', 'x'.repeat(32)),
    );
  });

  it('returns null when there are no digits', () => {
    expect(hashClaimPhone(' + ', key)).toBeNull();
  });
});
