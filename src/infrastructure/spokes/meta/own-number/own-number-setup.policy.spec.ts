import {
  decideNumberPath,
  generateRegistrationPin,
} from './own-number-setup.policy';

describe('decideNumberPath', () => {
  it.each([
    // hint, is_on_biz_app, platform_type, decision
    ['new_number', false, 'NOT_APPLICABLE', { kind: 'register' }],
    ['new_number', false, null, { kind: 'register' }],
    ['new_number', false, 'CLOUD_API', { kind: 'already_registered' }],
    ['coexistence', true, 'CLOUD_API', { kind: 'coexistence' }],
    ['coexistence', true, null, { kind: 'refuse', code: 'path_unverified' }],
    [
      'new_number',
      true,
      'CLOUD_API',
      { kind: 'refuse', code: 'path_mismatch' },
    ],
    [
      'coexistence',
      false,
      'NOT_APPLICABLE',
      { kind: 'refuse', code: 'path_mismatch' },
    ],
    [
      'coexistence',
      false,
      'CLOUD_API',
      { kind: 'refuse', code: 'path_mismatch' },
    ],
    [
      'new_number',
      null,
      'NOT_APPLICABLE',
      { kind: 'refuse', code: 'path_unverified' },
    ],
    [
      'coexistence',
      null,
      'CLOUD_API',
      { kind: 'refuse', code: 'path_unverified' },
    ],
  ] as const)(
    'hint %s, is_on_biz_app %s, platform %s',
    (hint, isOnBizApp, platformType, expected) => {
      expect(decideNumberPath(hint, { isOnBizApp, platformType })).toEqual(
        expected,
      );
    },
  );

  it('never registers on the browser hint alone', () => {
    for (const isOnBizApp of [true, null] as const)
      for (const platformType of ['CLOUD_API', 'NOT_APPLICABLE', null])
        expect(
          decideNumberPath('new_number', { isOnBizApp, platformType }).kind,
        ).not.toBe('register');
  });
});

describe('generateRegistrationPin', () => {
  it('is six digits, zero-padded, from the given source', () => {
    expect(generateRegistrationPin(() => 42)).toBe('000042');
    expect(generateRegistrationPin(() => 999_999)).toBe('999999');
  });

  it('asks the source for a value below one million', () => {
    const random = jest.fn(() => 7);
    generateRegistrationPin(random);
    expect(random).toHaveBeenCalledWith(1_000_000);
  });

  it('uses the secure source by default', () => {
    const pins = new Set(
      Array.from({ length: 50 }, () => generateRegistrationPin()),
    );
    for (const pin of pins) expect(pin).toMatch(/^\d{6}$/);
    expect(pins.size).toBeGreaterThan(1);
  });
});
