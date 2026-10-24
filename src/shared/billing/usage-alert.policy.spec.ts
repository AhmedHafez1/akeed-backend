import {
  capacityAction,
  creditAlertLevels,
  highestLevel,
  planUsageAlertLevels,
  planUsageCycleKey,
  recoveredCreditLevels,
  renewablePlanId,
} from './usage-alert.policy';

describe('planUsageAlertLevels', () => {
  it.each([
    [0, 1000, []],
    [799, 1000, []],
    [800, 1000, ['80']],
    [949, 1000, ['80']],
    [950, 1000, ['80', '95']],
    [999, 1000, ['80', '95']],
    [1000, 1000, ['80', '95', '100']],
    [1200, 1000, ['80', '95', '100']],
  ])('%i of %i reaches %j', (used, limit, expected) => {
    expect(planUsageAlertLevels(used, limit)).toEqual(expected);
  });

  it('rounds nothing: 24 of 30 is exactly 80%, 23 is not', () => {
    expect(planUsageAlertLevels(24, 30)).toEqual(['80']);
    expect(planUsageAlertLevels(23, 30)).toEqual([]);
  });

  it('has no levels without a finite allowance', () => {
    expect(planUsageAlertLevels(5, 0)).toEqual([]);
    expect(planUsageAlertLevels(5, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe('creditAlertLevels', () => {
  it.each([
    [11, 10, []],
    [10, 10, ['low']],
    [1, 10, ['low']],
    [0, 10, ['low', 'depleted']],
    [-3, 10, ['low', 'depleted']],
  ])(
    '%i credits with threshold %i reaches %j',
    (available, threshold, expected) => {
      expect(creditAlertLevels(available, threshold)).toEqual(expected);
    },
  );

  it('a threshold of 0 leaves only the depleted alert', () => {
    expect(creditAlertLevels(1, 0)).toEqual([]);
    expect(creditAlertLevels(0, 0)).toEqual(['depleted']);
  });

  it('resolves the levels the balance has climbed back above', () => {
    expect(recoveredCreditLevels(50, 10)).toEqual(['low', 'depleted']);
    expect(recoveredCreditLevels(5, 10)).toEqual(['depleted']);
    expect(recoveredCreditLevels(0, 10)).toEqual([]);
  });
});

describe('planUsageCycleKey', () => {
  it('is the period start for a rolling plan', () => {
    expect(planUsageCycleKey('pro', '2026-10-01')).toBe('2026-10-01');
  });

  it('marks the single period of a one-time plan', () => {
    expect(planUsageCycleKey('starter', '2026-10-01')).toBe(
      'one_time:2026-10-01',
    );
  });
});

describe('capacityAction', () => {
  it('recharges credits', () => {
    expect(capacityAction({ mode: 'credits', planId: null })).toBe('recharge');
  });

  it('upgrades a one-time or lower plan', () => {
    expect(capacityAction({ mode: 'plan', planId: 'starter' })).toBe('upgrade');
    expect(capacityAction({ mode: 'plan', planId: 'pro' })).toBe('upgrade');
  });

  it('waits for the reset on the top plan', () => {
    expect(capacityAction({ mode: 'plan', planId: 'business' })).toBe(
      'wait_reset',
    );
  });
});

describe('renewablePlanId', () => {
  it('renews a recurring paid plan, the top one included', () => {
    expect(renewablePlanId({ mode: 'plan', planId: 'basic' })).toBe('basic');
    expect(renewablePlanId({ mode: 'plan', planId: 'business' })).toBe(
      'business',
    );
  });

  it('never renews the one-time plan, credits or an unknown plan', () => {
    expect(renewablePlanId({ mode: 'plan', planId: 'starter' })).toBeNull();
    expect(renewablePlanId({ mode: 'credits', planId: 'basic' })).toBeNull();
    expect(renewablePlanId({ mode: 'plan', planId: null })).toBeNull();
  });
});

describe('highestLevel', () => {
  it('is the last reached level', () => {
    expect(highestLevel(['80', '95'])).toBe('95');
    expect(highestLevel([])).toBeNull();
  });
});
