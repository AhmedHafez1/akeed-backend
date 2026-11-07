import {
  evaluateChangeRequestOpen,
  shippingStateFromInspection,
  type ChangeRequestOpenFacts,
} from './change-request.policy';

function facts(
  overrides: Partial<ChangeRequestOpenFacts> = {},
): ChangeRequestOpenFacts {
  return {
    status: 'delivered',
    merchantCanceledAt: null,
    isTestOrder: false,
    currentCycle: 1,
    eventCycle: 1,
    shipping: 'unknown',
    autoCancelCommitted: false,
    hasOpenRequest: false,
    ...overrides,
  };
}

describe('evaluateChangeRequestOpen', () => {
  it.each([
    ['sent', 'open'],
    ['delivered', 'open'],
    ['read', 'open'],
    // A customer answer still overrides both no-reply statuses.
    ['no_reply', 'open'],
    ['no_whatsapp', 'open'],
    ['confirmed', 'reject'],
    ['canceled', 'reject'],
    ['pending', 'reject'],
    ['blocked', 'reject'],
    ['failed', 'reject'],
    ['expired', 'reject'],
  ])('status %s → %s', (status, kind) => {
    const decision = evaluateChangeRequestOpen(facts({ status }));
    expect(decision.kind).toBe(kind);
    if (decision.kind === 'reject')
      expect(decision.reason).toBe('not_awaiting_confirmation');
  });

  it('rejects an order known to have shipped and allows unknown shipping', () => {
    expect(evaluateChangeRequestOpen(facts({ shipping: 'shipped' }))).toEqual({
      kind: 'reject',
      reason: 'known_shipped',
    });
    expect(evaluateChangeRequestOpen(facts({ shipping: 'unknown' }))).toEqual({
      kind: 'open',
    });
    expect(
      evaluateChangeRequestOpen(facts({ shipping: 'not_shipped' })),
    ).toEqual({ kind: 'open' });
  });

  it('answers a repeat with the open request, never a second one', () => {
    expect(evaluateChangeRequestOpen(facts({ hasOpenRequest: true }))).toEqual({
      kind: 'already_open',
    });
  });

  it('rejects a retired cycle before saying anything else about the order', () => {
    expect(
      evaluateChangeRequestOpen(
        facts({ currentCycle: 2, eventCycle: 1, hasOpenRequest: true }),
      ),
    ).toEqual({ kind: 'reject', reason: 'stale_cycle' });
  });

  it.each([
    [{ merchantCanceledAt: '2026-11-01T00:00:00.000Z' }, 'merchant_canceled'],
    [
      { autoCancelCommitted: true, status: 'no_reply' },
      'auto_cancel_committed',
    ],
    [{ isTestOrder: true }, 'test_order'],
  ] as const)('rejects %o with %s', (override, reason) => {
    expect(evaluateChangeRequestOpen(facts(override))).toEqual({
      kind: 'reject',
      reason,
    });
  });
});

describe('shippingStateFromInspection', () => {
  it('treats only a fulfilled order as shipped', () => {
    expect(
      shippingStateFromInspection({
        state: 'not_cancellable',
        reason: 'fulfilled',
      }),
    ).toBe('shipped');
    expect(
      shippingStateFromInspection({
        state: 'not_cancellable',
        reason: 'fulfillment_in_progress',
      }),
    ).toBe('unknown');
    expect(
      shippingStateFromInspection({ state: 'not_cancellable', reason: 'paid' }),
    ).toBe('unknown');
  });

  it('never presents an unreadable store as verified unshipped', () => {
    expect(shippingStateFromInspection({ state: 'cancellable' })).toBe(
      'not_shipped',
    );
    for (const inspection of [
      { state: 'unsupported', reason: 'capability_not_supported' },
      { state: 'retryable_failure', errorCode: 'adapter_inspect_failed' },
      { state: 'permanent_failure', errorCode: 'integration_inactive' },
      { state: 'already_canceled' },
      null,
    ] as const)
      expect(shippingStateFromInspection(inspection)).toBe('unknown');
  });
});
