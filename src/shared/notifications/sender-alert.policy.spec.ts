import {
  FIRST_TIME_WINDOW_MS,
  inFirstTimeWindow,
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
  it.each([
    ['credentials', 'reconnect'],
    ['restricted', 'none'],
  ])(
    'reports %s even before another send, with action %s',
    (degradedClass, action) => {
      expect(evaluate({ degradedClass })).toMatchObject([
        { kind: 'fallback', reason: degradedClass, action },
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

describe('first-time setup window', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const template = (status: string) => ({
    key: 'cod_confirm.en',
    language: 'en',
    status,
    category: 'utility',
  });
  const fresh: SenderAlertFacts = {
    ...healthy,
    state: 'verifying',
    degradedClass: 'restricted',
    setupStatus: 'complete',
    connectedAt: hoursAgo(2),
    createdAt: hoursAgo(2),
    templates: [template('pending'), template('approved')],
  };
  const inWindow = (facts: Partial<SenderAlertFacts> = {}) =>
    inFirstTimeWindow({ ...fresh, ...facts }, now);

  it('holds back a restricted new number while its templates are in review', () => {
    expect(evaluate(fresh)).toMatchObject([
      { kind: 'fallback', reason: 'restricted' },
    ]);
    expect(inWindow()).toBe(true);
  });
  it.each(['connecting', 'verifying'])(
    'covers a %s number whose setup has not finished',
    (state) => {
      expect(
        inWindow({
          state,
          setupStatus: 'running',
          templates: [],
        }),
      ).toBe(true);
    },
  );
  it('treats every non-final template status as in review', () => {
    for (const status of [
      'pending',
      'in_appeal',
      'not_submitted',
      'submitting',
      'unresolved',
      'missing',
      'failed',
    ])
      expect(inWindow({ templates: [template(status)] })).toBe(true);
  });
  it('ends once every template is settled', () => {
    expect(inWindow({ templates: [template('approved')] })).toBe(false);
    expect(
      inWindow({ templates: [template('approved'), template('rejected')] }),
    ).toBe(false);
  });
  it('never covers a number that is, or was, active', () => {
    expect(inWindow({ state: 'active' })).toBe(false);
    expect(inWindow({ state: 'disconnected' })).toBe(false);
  });
  it('does not cover a reconnection of an existing number', () => {
    expect(inWindow({ stateReason: 'ACCOUNT_RECONNECTED' })).toBe(false);
  });
  it('lapses after 72 hours so a stalled review is reported', () => {
    expect(FIRST_TIME_WINDOW_MS).toBe(72 * 3_600_000);
    expect(
      inWindow({ connectedAt: hoursAgo(71), createdAt: hoursAgo(80) }),
    ).toBe(true);
    expect(
      inWindow({ connectedAt: hoursAgo(73), createdAt: hoursAgo(80) }),
    ).toBe(false);
  });
  it('falls back to the creation time when the number was never marked connected', () => {
    expect(inWindow({ connectedAt: null, createdAt: hoursAgo(1) })).toBe(true);
    expect(inWindow({ connectedAt: null, createdAt: hoursAgo(100) })).toBe(
      false,
    );
  });
  it('reports a closed window when the connection times are unknown', () => {
    expect(inWindow({ connectedAt: undefined, createdAt: undefined })).toBe(
      false,
    );
  });
});
