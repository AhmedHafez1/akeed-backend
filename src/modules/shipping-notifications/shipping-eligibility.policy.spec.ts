import {
  evaluateShippingEligibility,
  type ShippingEligibilityFacts,
} from './shipping-eligibility.policy';

const NOW = new Date('2026-11-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function facts(
  overrides: Partial<ShippingEligibilityFacts> = {},
): ShippingEligibilityFacts {
  return {
    isTest: false,
    verificationStatus: 'confirmed',
    verificationCanceledAt: null,
    merchantCanceledAt: null,
    sourceCancelledAt: null,
    sourceCreatedAt: new Date(NOW.getTime() - DAY).toISOString(),
    orderCreatedAt: new Date(NOW.getTime() - DAY).toISOString(),
    now: NOW,
    ...overrides,
  };
}

describe('evaluateShippingEligibility', () => {
  it.each(['confirmed', 'no_reply', 'sent', 'pending'])(
    'records a %s order as pending',
    (verificationStatus) => {
      expect(
        evaluateShippingEligibility(facts({ verificationStatus })),
      ).toEqual({ write: true, status: 'pending' });
    },
  );

  it('writes nothing for a test order', () => {
    expect(evaluateShippingEligibility(facts({ isTest: true }))).toEqual({
      write: false,
    });
  });

  it.each([
    { verificationStatus: 'canceled' },
    { verificationCanceledAt: '2026-11-23T00:00:00Z' },
    { merchantCanceledAt: '2026-11-23T00:00:00Z' },
    { sourceCancelledAt: '2026-11-23T00:00:00Z' },
  ])('fails a cancelled order: %j', (overrides) => {
    expect(evaluateShippingEligibility(facts(overrides))).toEqual({
      write: true,
      status: 'failed',
      reason: 'order_cancelled',
    });
  });

  it('allows exactly 30 days and fails anything older', () => {
    expect(
      evaluateShippingEligibility(
        facts({
          sourceCreatedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
        }),
      ),
    ).toEqual({ write: true, status: 'pending' });
    expect(
      evaluateShippingEligibility(
        facts({
          sourceCreatedAt: new Date(NOW.getTime() - 30 * DAY - 1).toISOString(),
        }),
      ),
    ).toEqual({ write: true, status: 'failed', reason: 'order_too_old' });
  });

  it("uses the store's creation time before Akeed's", () => {
    expect(
      evaluateShippingEligibility(
        facts({
          sourceCreatedAt: new Date(NOW.getTime() - 40 * DAY).toISOString(),
          orderCreatedAt: new Date(NOW.getTime() - DAY).toISOString(),
        }),
      ),
    ).toMatchObject({ reason: 'order_too_old' });
  });

  it("falls back to Akeed's time when the store's is missing or unreadable", () => {
    for (const sourceCreatedAt of [null, 'not a date']) {
      expect(
        evaluateShippingEligibility(
          facts({
            sourceCreatedAt,
            orderCreatedAt: new Date(NOW.getTime() - 31 * DAY).toISOString(),
          }),
        ),
      ).toMatchObject({ reason: 'order_too_old' });
    }
  });

  it('reports cancellation before age', () => {
    expect(
      evaluateShippingEligibility(
        facts({
          sourceCancelledAt: '2026-10-01T00:00:00Z',
          sourceCreatedAt: '2026-09-01T00:00:00Z',
        }),
      ),
    ).toMatchObject({ reason: 'order_cancelled' });
  });
});
