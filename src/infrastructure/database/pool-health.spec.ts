import { DatabaseTimeoutError } from '../../shared/errors/database-timeout.error';
import {
  pingWithin,
  PoolWatchdog,
  type PingResult,
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
  function build(pool: PingResult[], fresh: PingResult[] = [ok]) {
    const events: PoolWatchdogEvent[] = [];
    const exit = jest.fn();
    const pingFresh = jest.fn(() => Promise.resolve(fresh.shift() ?? ok));
    const watchdog = new PoolWatchdog({
      pingPool: () => Promise.resolve(pool.shift() ?? ok),
      pingFresh,
      failuresBeforeExit: 3,
      onCheck: (event) => events.push(event),
      exit,
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
});
