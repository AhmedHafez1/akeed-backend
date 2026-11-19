import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DATABASE_RESILIENCE_CONFIG,
  DATABASE_RESILIENCE_DEFAULTS,
  type DatabaseResilienceConfig,
} from '../../shared/config/database-resilience.config';
import { DatabasePoolWatchdog } from './database-pool-watchdog';
import type { DrizzleDB } from './database.provider';
import * as poolHealth from './pool-health';

function build(
  overrides: Partial<DatabaseResilienceConfig>,
  execute: () => Promise<unknown>,
  pool: { enabled: boolean; allowed?: () => boolean } = { enabled: false },
) {
  const settings = {
    ...DATABASE_RESILIENCE_DEFAULTS,
    pingTimeoutMs: 100,
    watchdogIntervalMs: 1_000,
    watchdogFailures: 2,
    ...overrides,
  };
  const config = {
    get: (key: string) =>
      key === DATABASE_RESILIENCE_CONFIG ? settings : undefined,
    getOrThrow: () => 'postgresql://u:p@db.example:6543/postgres',
  } as unknown as ConfigService;
  const db = { execute: jest.fn(execute) };
  const recycle = jest.fn();
  const control = {
    enabled: pool.enabled,
    recycler: jest.fn(() => ({
      allowed: pool.allowed ?? (() => true),
      recycle,
    })),
  };
  const watchdog = new DatabasePoolWatchdog(
    db as unknown as DrizzleDB,
    config,
    control,
  );
  watchdog.exitProcess = jest.fn();
  return { watchdog, db, recycle, control };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function runChecks(checks: number): Promise<void> {
  for (let check = 0; check < checks; check += 1) {
    jest.advanceTimersByTime(1_000);
    await flush();
    jest.advanceTimersByTime(100);
    await flush();
  }
}

describe('DatabasePoolWatchdog', () => {
  let fatal: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    fatal = jest
      .spyOn(Logger.prototype, 'fatal')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing when disabled', () => {
    const { watchdog, db } = build({ watchdogEnabled: false }, () =>
      Promise.resolve([]),
    );

    watchdog.onApplicationBootstrap();
    jest.advanceTimersByTime(10_000);

    expect(db.execute).not.toHaveBeenCalled();
  });

  it('exits after consecutive missed pings when a fresh client answers', async () => {
    jest
      .spyOn(poolHealth, 'pingWithFreshClient')
      .mockResolvedValue({ outcome: 'ok', elapsedMs: 5 });
    const { watchdog, db } = build({}, () => new Promise(() => undefined));

    watchdog.onApplicationBootstrap();
    for (let check = 0; check < 2; check += 1) {
      jest.advanceTimersByTime(1_000);
      await flush();
      jest.advanceTimersByTime(100);
      await flush();
    }

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(watchdog.exitProcess).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith(
      expect.stringContaining('"action":"database-pool-wedged"'),
    );

    // No further checks after deciding to exit.
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('replaces a wedged pool instead of exiting when replacement is allowed', async () => {
    jest
      .spyOn(poolHealth, 'pingWithFreshClient')
      .mockResolvedValue({ outcome: 'ok', elapsedMs: 5 });
    const { watchdog, db, recycle, control } = build(
      {},
      () => new Promise(() => undefined),
      { enabled: true },
    );

    watchdog.onApplicationBootstrap();
    await runChecks(2);

    expect(control.recycler).toHaveBeenCalledWith('wedged');
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(watchdog.exitProcess).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"processAction":"recycle"'),
    );

    // Checking continues against the replacement pool.
    await runChecks(1);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it('exits when the pool is wedged again within the replacement cooldown', async () => {
    jest
      .spyOn(poolHealth, 'pingWithFreshClient')
      .mockResolvedValue({ outcome: 'ok', elapsedMs: 5 });
    const { watchdog, recycle } = build(
      {},
      () => new Promise(() => undefined),
      { enabled: true, allowed: () => false },
    );

    watchdog.onApplicationBootstrap();
    await runChecks(2);

    expect(recycle).not.toHaveBeenCalled();
    expect(watchdog.exitProcess).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith(
      expect.stringContaining('"processAction":"exit"'),
    );
  });

  it('stops checking on shutdown', async () => {
    const { watchdog, db } = build({}, () => Promise.resolve([]));

    watchdog.onApplicationBootstrap();
    jest.advanceTimersByTime(1_000);
    await flush();
    watchdog.onModuleDestroy();
    jest.advanceTimersByTime(5_000);
    await flush();

    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
