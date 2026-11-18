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
  const watchdog = new DatabasePoolWatchdog(db as unknown as DrizzleDB, config);
  watchdog.exitProcess = jest.fn();
  return { watchdog, db };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('DatabasePoolWatchdog', () => {
  let fatal: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
