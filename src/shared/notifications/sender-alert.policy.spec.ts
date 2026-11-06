import {
  senderAlerts,
  suppressFallbackEmail,
  type SenderAlertFacts,
} from './sender-alert.policy';

const healthy: SenderAlertFacts = {
  state: 'active',
  stateReason: null,
  degradedClass: null,
  qualityRating: 'GREEN',
  templates: [],
  fallback: null,
  merchantAcceptedAt: null,
};
const evaluate = (facts: Partial<SenderAlertFacts> = {}, enabled = true) =>
  senderAlerts({ ...healthy, ...facts }, enabled);

describe('sender alerts', () => {
  it('has no banner for a healthy number or yellow/unknown quality', () => {
    for (const qualityRating of ['GREEN', 'YELLOW', 'UNKNOWN', null])
      expect(evaluate({ qualityRating })).toEqual([]);
  });
  it('alerts only at red quality and closes on yellow/green', () => {
    expect(evaluate({ qualityRating: 'RED' })).toMatchObject([
      { kind: 'quality_drop', reason: 'red' },
    ]);
    expect(evaluate({ qualityRating: 'YELLOW' })).toEqual([]);
  });
  it.each(['disconnected', 'offboarded'])(
    'shows %s even when sending is disabled',
    (state) => {
      expect(evaluate({ state }, false)).toMatchObject([
        { kind: 'disconnect' },
      ]);
    },
  );
  it('keeps a disconnect during reconnection until verified active', () => {
    expect(
      evaluate({ state: 'verifying', stateReason: 'ACCOUNT_RECONNECTED' }),
    ).toMatchObject([{ kind: 'disconnect' }]);
    expect(evaluate()).toEqual([]);
  });
  it('names primary inactivity without copying arbitrary provider reasons', () => {
    expect(
      evaluate({ state: 'disconnected', stateReason: 'PRIMARY_INACTIVITY' })[0]
        .reason,
    ).toBe('primary_inactivity');
    expect(
      evaluate({ state: 'disconnected', stateReason: 'raw secret' })[0].reason,
    ).toBe('disconnected');
  });
  it('groups rejected, paused, disabled and marketing templates; excludes pending', () => {
    const templates = [
      'rejected',
      'paused',
      'disabled',
      'approved',
      'pending',
    ].map((status, i) => ({
      key: `key${i}`,
      language: i % 2 ? 'ar' : 'en',
      status,
      category: i === 3 ? 'marketing' : 'utility',
    }));
    const result = evaluate({ templates });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'template_rejection',
      reason: 'recategorized',
    });
    expect(result[0].templates).toHaveLength(4);
    expect(
      evaluate({
        templates: templates.map((t) => ({
          ...t,
          category: 'utility',
          status: 'approved',
        })),
      }),
    ).toEqual([]);
  });
  it('shows payment and suppresses duplicate fallback email', () => {
    const result = evaluate({
      degradedClass: 'payment',
      fallback: { reason: 'degraded:payment', at: '2026-11-04T10:00:00Z' },
    });
    expect(result.map((a) => a.kind)).toEqual(['payment', 'fallback']);
    expect(suppressFallbackEmail(result)).toBe(true);
  });
  it.each(['credentials', 'restricted'])(
    'gives an action for %s even before another send',
    (degradedClass) => {
      expect(evaluate({ degradedClass })).toMatchObject([
        { kind: 'fallback', reason: degradedClass },
      ]);
    },
  );
  it('closes transient fallback after a newer merchant success and respects the sending switch', () => {
    const fallback = { reason: 'outcome_unknown', at: '2026-11-04T10:00:00Z' };
    expect(evaluate({ fallback })).toMatchObject([{ kind: 'fallback' }]);
    expect(
      evaluate({ fallback, merchantAcceptedAt: '2026-11-04T10:01:00Z' }),
    ).toEqual([]);
    expect(evaluate({ fallback }, false)).toEqual([]);
    expect(suppressFallbackEmail(evaluate({ fallback }))).toBe(false);
  });
});
