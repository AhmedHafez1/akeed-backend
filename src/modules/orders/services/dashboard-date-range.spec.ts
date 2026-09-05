import {
  resolveDashboardDateRangeBounds,
  resolveDashboardTimezone,
} from './dashboard-date-range';

describe('resolveDashboardDateRangeBounds', () => {
  it('uses merchant-local calendar days across a DST transition', () => {
    const bounds = resolveDashboardDateRangeBounds(
      'today',
      'America/New_York',
      new Date('2024-03-10T16:00:00.000Z'),
    );

    expect(bounds).toEqual({
      startAt: '2024-03-10T05:00:00.000Z',
      endAt: '2024-03-11T04:00:00.000Z',
    });
  });

  it('includes seven merchant-local calendar days', () => {
    const bounds = resolveDashboardDateRangeBounds(
      'last_7_days',
      'Asia/Riyadh',
      new Date('2026-05-10T12:00:00.000Z'),
    );

    expect(bounds).toEqual({
      startAt: '2026-05-03T21:00:00.000Z',
      endAt: '2026-05-10T21:00:00.000Z',
    });
  });

  it('falls back to UTC when the source timezone is invalid', () => {
    const bounds = resolveDashboardDateRangeBounds(
      'last_30_days',
      'not-a-timezone',
      new Date('2026-05-10T12:00:00.000Z'),
    );

    expect(bounds).toEqual({
      startAt: '2026-04-11T00:00:00.000Z',
      endAt: '2026-05-11T00:00:00.000Z',
    });
    expect(resolveDashboardTimezone('not-a-timezone')).toBe('UTC');
  });
});
