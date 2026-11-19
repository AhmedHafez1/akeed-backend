import { DatabasePoolControl } from './database-pool-control';
import type { PingResult } from './pool-health';
import type { SwappableClient } from './swappable-client';

const ok: PingResult = { outcome: 'ok', elapsedMs: 2 };

function build(
  overrides: { enabled?: boolean; fresh?: () => Promise<PingResult> } = {},
) {
  let clock = 1_000_000;
  let generation = 1;
  const pool = {
    client: {},
    get generation() {
      return generation;
    },
    replace: jest.fn(() => {
      generation += 1;
      return { generation, drained: Promise.resolve('ended' as const) };
    }),
    endAll: jest.fn(() => Promise.resolve()),
  } as unknown as SwappableClient<object> & { replace: jest.Mock };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const control = new DatabasePoolControl(pool, {
    enabled: overrides.enabled ?? true,
    cooldownMs: 60_000,
    drainTimeoutSeconds: 60,
    deadlineThreshold: 3,
    deadlineWindowMs: 60_000,
    pingFresh: overrides.fresh ?? (() => Promise.resolve(ok)),
    logger,
    now: () => clock,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { control, pool, logger, advance };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('DatabasePoolControl', () => {
  it('replaces the pool once per cooldown', () => {
    const { control, pool, logger, advance } = build();

    expect(control.recycle('wedged')).toBe(true);
    expect(pool.replace).toHaveBeenCalledWith(60);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"action":"database-pool-recycle"'),
    );
    expect(control.allowed()).toBe(false);
    expect(control.recycle('deadline-burst')).toBe(false);

    advance(60_000);
    expect(control.allowed()).toBe(true);
    expect(control.recycle('deadline-burst')).toBe(true);
    expect(pool.replace).toHaveBeenCalledTimes(2);
  });

  it('never replaces the pool when disabled', async () => {
    const { control, pool } = build({ enabled: false });

    expect(control.recycle('wedged')).toBe(false);
    for (let index = 0; index < 5; index += 1) control.noteDeadline();
    await settle();

    expect(pool.replace).not.toHaveBeenCalled();
  });

  it('replaces the pool after a burst of missed deadlines', async () => {
    const { control, pool, logger } = build();

    control.noteDeadline();
    control.noteDeadline();
    await settle();
    expect(pool.replace).not.toHaveBeenCalled();
    control.noteDeadline();
    await settle();

    expect(pool.replace).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"trigger":"deadline-burst"'),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('"action":"database-pool-recycle-drained"'),
    );
  });

  it('logs a failed burst check instead of throwing', async () => {
    const { control, pool, logger } = build({
      fresh: () => Promise.reject(new Error('boom')),
    });

    for (let index = 0; index < 3; index += 1) control.noteDeadline();
    await settle();

    expect(pool.replace).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"action":"database-deadline-burst"'),
    );
  });
});
