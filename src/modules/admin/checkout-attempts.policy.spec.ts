import { checkoutOutcome } from './checkout-attempts.policy';

const NOW = Date.parse('2026-11-19T21:00:00Z');
const base = { declineCode: null, checkoutExpiresAt: null };

describe('checkoutOutcome', () => {
  it.each(['successful', 'refunded'])('reads %s as paid', (status) => {
    expect(checkoutOutcome({ ...base, status }, NOW)).toBe('paid');
  });

  it('names a bank decline apart from a checkout Paymob refused', () => {
    expect(
      checkoutOutcome(
        { ...base, status: 'failed', declineCode: 'authentication_failed' },
        NOW,
      ),
    ).toBe('declined');
    expect(checkoutOutcome({ ...base, status: 'failed' }, NOW)).toBe('failed');
  });

  it('reads canceled and expired checkouts', () => {
    expect(checkoutOutcome({ ...base, status: 'canceled' }, NOW)).toBe(
      'canceled',
    );
    expect(checkoutOutcome({ ...base, status: 'expired' }, NOW)).toBe(
      'left_checkout',
    );
  });

  it('treats a pending checkout past its window as left, and one inside it as open', () => {
    expect(
      checkoutOutcome(
        {
          ...base,
          status: 'pending',
          checkoutExpiresAt: '2026-11-19T20:59:59Z',
        },
        NOW,
      ),
    ).toBe('left_checkout');
    expect(
      checkoutOutcome(
        {
          ...base,
          status: 'pending',
          checkoutExpiresAt: '2026-11-19T21:10:00Z',
        },
        NOW,
      ),
    ).toBe('in_checkout');
    expect(checkoutOutcome({ ...base, status: 'pending' }, NOW)).toBe(
      'in_checkout',
    );
  });
});
