import { DatabaseTimeoutError } from '../../shared/errors/database-timeout.error';
import {
  DeadlineBurstDetector,
  pingWithin,
  PoolWatchdog,
  type DeadlineBurstEvent,
  type PingResult,
  type PoolRecycler,
  type PoolWatchdogEvent,
} from './pool-health';

const ok: PingResult = { outcome: 'ok', elapsedMs: 3 };
const timeout: PingResult = { outcome: 'timeout', elapsedMs: 5_000 };
const failed: PingResult = {
  outcome: 'error',
  elapsedMs: 4,
  error: new Error('ECONNREFUSED'),
};

describe('pingWithin', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reports ok when the statement answers', async () => {
    await expect(
      pingWithin(() => Promise.resolve(), 100),
    ).resolves.toMatchObject({ outcome: 'ok' });
  });

  it('reports a timeout when the statement never answers', async () => {
    const result = pingWithin(() => new Promise(() => undefined), 100);
    jest.advanceTimersByTime(100);

    await expect(result).resolves.toMatchObject({ outcome: 'timeout' });
  });

  it('treats a statement deadline as a timeout and other failures as errors', async () => {
    await expect(
      pingWithin(
        () => Promise.reject(new DatabaseTimeoutError('query', 50)),
        100,
      ),
    ).resolves.toMatchObject({ outcome: 'timeout' });
    const error = new Error('password authentication failed');
    await expect(
      pingWithin(() => Promise.reject(error), 100),
    ).resolves.toMatchObject({ outcome: 'error', error });
  });
});

describe('PoolWatchdog', () => {
  function build(
    pool: PingResult[],
    fresh: PingResult[] = [ok],
    recycler?: PoolRecycler,
  ) {
    const events: PoolWatchdogEvent[] = [];
    const exit = jest.fn();
    const pingFresh = jest.fn(() => Promise.resolve(fresh.shift() ?? ok));
    const watchdog = new PoolWatchdog({
      pingPool: () => Promise.resolve(pool.shift() ?? ok),
      pingFresh,
      failuresBeforeExit: 3,
      onCheck: (event) => events.push(event),
      exit,
      recycler,
    });
    return { watchdog, events, exit, pingFresh };
  }

  async function run(watchdog: PoolWatchdog, checks: number) {
    for (let index = 0; index < checks; index += 1) await watchdog.check();
  }

  it('stays quiet while the pool answers', async () => {
    const { watchdog, events, exit } = build([ok, ok, ok]);

    await run(watchdog, 3);

    expect(events).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits once the pool misses the threshold while a fresh client answers', async () => {
    const { watchdog, events, exit, pingFresh } = build([
      timeout,
      timeout,
      timeout,
    ]);

    await run(watchdog, 2);
    expect(pingFresh).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await watchdog.check();
    expect(pingFresh).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.kind)).toEqual([
      'pool-timeout',
      'pool-timeout',
      'pool-timeout',
      'pool-wedged',
    ]);
  });

  it('does not exit when a fresh client cannot reach the database either', async () => {
    const { watchdog, events, exit } = build(
      [timeout, timeout, timeout, timeout],
      [timeout, failed],
    );

    await run(watchdog, 4);

    expect(exit).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.kind === 'database-unreachable'),
    ).toHaveLength(2);
    expect(watchdog.consecutiveTimeouts).toBe(4);
  });

  it('starts counting again after an answer', async () => {
    const { watchdog, events, exit } = build([
      timeout,
      timeout,
      ok,
      timeout,
      timeout,
    ]);

    await run(watchdog, 5);

    expect(exit).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: 'recovered', missedChecks: 2 });
    expect(watchdog.consecutiveTimeouts).toBe(2);
  });

  it('does not count errors that come back, since the driver is still talking', async () => {
    const { watchdog, exit } = build([timeout, timeout, failed, timeout]);

    await run(watchdog, 4);

    expect(exit).not.toHaveBeenCalled();
    expect(watchdog.consecutiveTimeouts).toBe(1);
  });

  it('replaces the pool at the threshold when a replacement is allowed', async () => {
    const recycler = { allowed: jest.fn(() => true), recycle: jest.fn() };
    const { watchdog, events, exit } = build(
      [timeout, timeout, timeout],
      [ok],
      recycler,
    );

    await run(watchdog, 3);

    expect(recycler.recycle).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ kind: 'pool-recycled' });
    expect(watchdog.consecutiveTimeouts).toBe(0);
  });

  it('exits when a replacement is not allowed', async () => {
    const recycler = { allowed: () => false, recycle: jest.fn() };
    const { watchdog, events, exit } = build(
      [timeout, timeout, timeout],
      [ok],
      recycler,
    );

    await run(watchdog, 3);

    expect(recycler.recycle).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ kind: 'pool-wedged' });
  });

  it('neither replaces nor exits when the database is unreachable', async () => {
    const recycler = { allowed: () => true, recycle: jest.fn() };
    const { watchdog, exit } = build(
      [timeout, timeout, timeout],
      [failed],
      recycler,
    );

    await run(watchdog, 3);

    expect(recycler.recycle).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('DeadlineBurstDetector', () => {
  function build(
    options: {
      fresh?: PingResult[];
      allowed?: () => boolean;
      threshold?: number;
    } = {},
  ) {
    let clock = 0;
    const events: DeadlineBurstEvent[] = [];
    const fresh = options.fresh ?? [ok];
    const pingFresh = jest.fn(() => Promise.resolve(fresh.shift() ?? ok));
    const recycler = {
      allowed: jest.fn(options.allowed ?? (() => true)),
      recycle: jest.fn(),
    };
    const detector = new DeadlineBurstDetector({
      threshold: options.threshold ?? 3,
      windowMs: 60_000,
      now: () => clock,
      pingFresh,
      recycler,
      onBurst: (event) => events.push(event),
    });
    const at = (ms: number) => {
      clock = ms;
      return detector.record();
    };
    return { detector, events, pingFresh, recycler, at };
  }

  it('replaces the pool once the threshold falls within the window', async () => {
    const { events, pingFresh, recycler, at } = build();

    await at(0);
    await at(10_000);
    expect(pingFresh).not.toHaveBeenCalled();
    await at(20_000);

    expect(pingFresh).toHaveBeenCalledTimes(1);
    expect(recycler.recycle).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ kind: 'recycle', deadlines: 3, fresh: ok }]);
  });

  it('forgets deadlines that fall out of the window', async () => {
    const { recycler, detector, at } = build();

    await at(0);
    await at(10_000);
    await at(70_001);

    expect(recycler.recycle).not.toHaveBeenCalled();
    expect(detector.recentDeadlines).toBe(1);
  });

  it('does nothing while a replacement is not allowed', async () => {
    const { pingFresh, recycler, at } = build({ allowed: () => false });

    for (const ms of [0, 1_000, 2_000, 3_000]) await at(ms);

    expect(pingFresh).not.toHaveBeenCalled();
    expect(recycler.recycle).not.toHaveBeenCalled();
  });

  it('does not replace the pool when the database itself is unreachable', async () => {
    const { events, recycler, at } = build({ fresh: [timeout] });

    for (const ms of [0, 1_000, 2_000]) await at(ms);

    expect(recycler.recycle).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'database-unreachable', deadlines: 3, fresh: timeout },
    ]);
  });

  it('checks once while a fresh ping is already running', async () => {
    let answer: (result: PingResult) => void = () => undefined;
    const { recycler, pingFresh, detector } = build({ threshold: 1 });
    pingFresh.mockImplementationOnce(
      () => new Promise<PingResult>((resolve) => (answer = resolve)),
    );

    const first = detector.record();
    let secondSettled = false;
    const second = detector.record().then(() => (secondSettled = true));
    await Promise.resolve();
    // The later deadline waits for the running check's decision.
    expect(secondSettled).toBe(false);
    expect(recycler.recycle).not.toHaveBeenCalled();

    answer(ok);
    await Promise.all([first, second]);

    expect(secondSettled).toBe(true);
    expect(pingFresh).toHaveBeenCalledTimes(1);
    expect(recycler.recycle).toHaveBeenCalledTimes(1);
  });

  it('skips the replacement when another trigger replaced the pool during the ping', async () => {
    let allowed = true;
    const { recycler, pingFresh, at } = build({ allowed: () => allowed });
    pingFresh.mockImplementationOnce(() => {
      allowed = false;
      return Promise.resolve(ok);
    });

    for (const ms of [0, 1_000, 2_000]) await at(ms);

    expect(recycler.recycle).not.toHaveBeenCalled();
  });
});
