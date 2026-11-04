import { classifyOwnNumberFailure } from './own-number-send-failure.policy';

describe('merchant sender failure policy', () => {
  const table = [
    ['recipient', 'fail', null, [131026, 131021, 131050, 131049]],
    [
      'retryable',
      'retry',
      null,
      [1, 2, 4, 80007, 130429, 131000, 131016, 131056, 131057, 133004],
    ],
    ['credentials', 'fallback', 'credentials', [0, 3, 10, 190, 200, 131005]],
    ['payment', 'fallback', 'payment', [131042]],
    [
      'restricted',
      'fallback',
      'restricted',
      [368, 131031, 131045, 131048, 133010, 131037],
    ],
    ['template', 'fallback', null, [132001, 132007, 132015, 132016]],
    [
      'payload',
      'fallback',
      null,
      [100, 131008, 131009, 132000, 132005, 132012, 135000],
    ],
  ] as const;
  for (const [kind, action, degrade, codes] of table) {
    it.each(codes)(
      'classifies %s identically for synchronous and webhook inputs',
      (code) => {
        expect(
          classifyOwnNumberFailure({ code, httpStatus: 400 }),
        ).toMatchObject({ class: kind, code: String(code), action, degrade });
        expect(classifyOwnNumberFailure({ code: ` ${code} ` })).toEqual(
          classifyOwnNumberFailure({ code }),
        );
      },
    );
  }
  it.each([undefined, null, '', 'bad', -1, NaN, Infinity, {}, 1.5])(
    'treats missing/invalid code %s as unknown outcome',
    (code) => {
      expect(classifyOwnNumberFailure({ code })).toMatchObject({
        class: 'outcome_unknown',
        action: 'fallback',
        degrade: null,
      });
    },
  );
  it.each([
    { transport: true },
    { missingMessageId: true },
    { code: 131000, httpStatus: 503 },
  ])('ambiguous outcomes do not retry: %j', (input) => {
    expect(classifyOwnNumberFailure(input).class).toBe('outcome_unknown');
  });
  it('falls back on an unlisted code without degradation', () =>
    expect(classifyOwnNumberFailure({ code: 999999 })).toEqual({
      class: 'unknown',
      code: '999999',
      action: 'fallback',
      degrade: null,
    }));
  it('maps each template failure to the affected template state', () => {
    expect(
      [132001, 132007, 132015, 132016].map(
        (code) => classifyOwnNumberFailure({ code }).templateStatus,
      ),
    ).toEqual(['missing', 'rejected', 'paused', 'disabled']);
  });
  it('distinguishes local credentials from a disabled send', () => {
    expect(
      classifyOwnNumberFailure({ localCode: 'sender_credentials_unavailable' })
        .degrade,
    ).toBe('credentials');
    expect(
      classifyOwnNumberFailure({ localCode: 'own_number_sending_disabled' })
        .degrade,
    ).toBeNull();
  });
});
