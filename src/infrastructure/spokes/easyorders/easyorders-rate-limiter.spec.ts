import {
  EASYORDERS_LOOKUPS_PER_MINUTE,
  EASYORDERS_REQUESTS_PER_MINUTE,
  EasyOrdersRateLimiter,
  msUntilNextMinute,
} from './easyorders-rate-limiter';

const MINUTE_START = Date.parse('2026-10-03T10:00:00.000Z');
const noJitter = () => 0;

describe('EasyOrdersRateLimiter', () => {
  it('stops lookups below the total so outcome writes keep headroom', () => {
    const limiter = new EasyOrdersRateLimiter();
    const now = MINUTE_START + 5_000;

    for (let call = 0; call < EASYORDERS_LOOKUPS_PER_MINUTE; call += 1)
      expect(limiter.acquire('int-a', 'lookup', now)).toEqual({
        allowed: true,
      });

    expect(limiter.acquire('int-a', 'lookup', now, noJitter)).toEqual({
      allowed: false,
      retryAfterMs: 55_000,
    });
    expect(limiter.acquire('int-a', 'outcome', now)).toEqual({ allowed: true });
  });

  it('never spends more than the budget in one clock minute', () => {
    const limiter = new EasyOrdersRateLimiter();
    const now = MINUTE_START;
    let allowed = 0;

    for (let call = 0; call < EASYORDERS_REQUESTS_PER_MINUTE + 10; call += 1)
      if (limiter.acquire('int-a', 'outcome', now).allowed) allowed += 1;

    expect(allowed).toBe(EASYORDERS_REQUESTS_PER_MINUTE);
    expect(EASYORDERS_REQUESTS_PER_MINUTE).toBeLessThan(40);
  });

  it('opens a new budget on the next clock minute', () => {
    const limiter = new EasyOrdersRateLimiter();
    for (let call = 0; call < EASYORDERS_REQUESTS_PER_MINUTE; call += 1)
      limiter.acquire('int-a', 'outcome', MINUTE_START + 59_000);

    expect(
      limiter.acquire('int-a', 'outcome', MINUTE_START + 59_999).allowed,
    ).toBe(false);
    expect(
      limiter.acquire('int-a', 'outcome', MINUTE_START + 60_000).allowed,
    ).toBe(true);
  });

  it('keeps one integration from using another one’s budget', () => {
    const limiter = new EasyOrdersRateLimiter();
    for (let call = 0; call < EASYORDERS_REQUESTS_PER_MINUTE; call += 1)
      limiter.acquire('int-a', 'outcome', MINUTE_START);

    expect(limiter.acquire('int-a', 'outcome', MINUTE_START).allowed).toBe(
      false,
    );
    expect(limiter.acquire('int-b', 'lookup', MINUTE_START).allowed).toBe(true);
  });

  it('pauses every call of a rate-limited integration, across the minute', () => {
    const limiter = new EasyOrdersRateLimiter();
    limiter.pause('int-a', 90_000, MINUTE_START);

    expect(limiter.acquire('int-a', 'outcome', MINUTE_START + 60_000)).toEqual({
      allowed: false,
      retryAfterMs: 30_000,
    });
    expect(limiter.acquire('int-b', 'outcome', MINUTE_START).allowed).toBe(
      true,
    );
    expect(
      limiter.acquire('int-a', 'outcome', MINUTE_START + 90_000).allowed,
    ).toBe(true);
  });
});

describe('msUntilNextMinute', () => {
  it('waits for the next clock minute plus at most ten seconds of jitter', () => {
    expect(msUntilNextMinute(MINUTE_START + 45_000, noJitter)).toBe(15_000);
    expect(msUntilNextMinute(MINUTE_START + 45_000, () => 0.999)).toBe(24_990);
  });
});
