import { nextQuietHoursStart } from '../../../shared/utils/quiet-hours.util';
import {
  estimateReleaseMinutes,
  releaseBudgetPerTick,
  suggestedCreditPurchase,
} from './release-policy';

/** Cairo is UTC+3 on these September dates (daylight saving time). */
const cairoQuiet = {
  enabled: true,
  start: '22:00',
  end: '09:00',
  timezone: 'Africa/Cairo',
};

describe('release policy', () => {
  it.each([
    [1, 1],
    [20, 10],
    [21, 11],
    [120, 60],
  ])('releases ceil(rate × 0.5) per tick at %i/min', (rate, budget) => {
    expect(releaseBudgetPerTick(rate)).toBe(budget);
  });

  it.each([
    [1, 100],
    [100, 100],
    [101, 150],
    [570, 600],
    [600, 600],
    [601, 650],
  ])(
    'suggests buying at least 100, rounded up to 50, for %i short',
    (shortfall, credits) => {
      expect(suggestedCreditPurchase(shortfall)).toBe(credits);
    },
  );

  it('is ceil(N / rate) without quiet hours', () => {
    expect(
      estimateReleaseMinutes({
        orders: 970,
        ratePerMinute: 20,
        now: new Date('2026-09-21T11:00:00Z'),
        quietHours: { enabled: false },
      }),
    ).toBe(49);
    expect(
      estimateReleaseMinutes({
        orders: 0,
        ratePerMinute: 20,
        now: new Date('2026-09-21T11:00:00Z'),
        quietHours: cairoQuiet,
      }),
    ).toBe(0);
  });

  it('adds the overnight quiet window a span runs into', () => {
    // 21:30 Cairo: 30 sending minutes, then 11 quiet hours, then 19 more.
    expect(
      estimateReleaseMinutes({
        orders: 970,
        ratePerMinute: 20,
        now: new Date('2026-09-21T18:30:00Z'),
        quietHours: cairoQuiet,
      }),
    ).toBe(49 + 11 * 60);
  });

  it('waits out the rest of the window when it starts inside it', () => {
    // 08:00 Cairo: one quiet hour left, then 49 sending minutes.
    expect(
      estimateReleaseMinutes({
        orders: 970,
        ratePerMinute: 20,
        now: new Date('2026-09-21T05:00:00Z'),
        quietHours: cairoQuiet,
      }),
    ).toBe(60 + 49);
  });

  it('crosses several nights for a slow, long release', () => {
    // 5,000 orders at 1/min from 09:00 Cairo: 13 h sending a day.
    const minutes = estimateReleaseMinutes({
      orders: 5_000,
      ratePerMinute: 1,
      now: new Date('2026-09-21T06:00:00Z'),
      quietHours: cairoQuiet,
    });
    const nights = Math.floor(5_000 / (13 * 60));
    expect(minutes).toBe(5_000 + nights * 11 * 60);
  });

  it('handles a same-day window', () => {
    // 12:50 Cairo, quiet 13:00–15:00: 10 minutes, 2 hours, 39 minutes.
    expect(
      estimateReleaseMinutes({
        orders: 970,
        ratePerMinute: 20,
        now: new Date('2026-09-21T09:50:00Z'),
        quietHours: { ...cairoQuiet, start: '13:00', end: '15:00' },
      }),
    ).toBe(49 + 120);
  });

  it('finds the next window start, tomorrow when today’s has begun', () => {
    expect(
      nextQuietHoursStart(new Date('2026-09-21T18:30:00Z'), cairoQuiet),
    ).toEqual(new Date('2026-09-21T19:00:00Z'));
    expect(
      nextQuietHoursStart(new Date('2026-09-21T19:30:00Z'), cairoQuiet),
    ).toEqual(new Date('2026-09-22T19:00:00Z'));
    expect(
      nextQuietHoursStart(new Date('2026-09-21T18:30:00Z'), {
        enabled: false,
      }),
    ).toBeNull();
  });
});
