import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';
import {
  DATABASE_RESILIENCE_CONFIG,
  DATABASE_RESILIENCE_DEFAULTS,
} from './shared/config/database-resilience.config';
import type { DrizzleDB } from './infrastructure/database';

function build(execute: () => Promise<unknown>) {
  const config = {
    get: (key: string) =>
      key === DATABASE_RESILIENCE_CONFIG
        ? { ...DATABASE_RESILIENCE_DEFAULTS, pingTimeoutMs: 100 }
        : undefined,
  } as unknown as ConfigService;
  return new AppService({ execute } as unknown as DrizzleDB, config);
}

describe('AppService.getHealth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is ok when the pool answers', async () => {
    await expect(
      build(() => Promise.resolve([])).getHealth(),
    ).resolves.toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });

  it('is degraded when the pool errors', async () => {
    await expect(
      build(() => Promise.reject(new Error('ECONNREFUSED'))).getHealth(),
    ).resolves.toMatchObject({
      status: 'degraded',
      checks: { database: 'error' },
    });
  });

  it('answers degraded at the ping deadline instead of waiting on a stuck pool', async () => {
    const health = build(() => new Promise(() => undefined)).getHealth();
    jest.advanceTimersByTime(100);

    await expect(health).resolves.toMatchObject({
      status: 'degraded',
      checks: { database: 'error' },
    });
  });
});
