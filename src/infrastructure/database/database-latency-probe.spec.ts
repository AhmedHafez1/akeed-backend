import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import postgres from 'postgres';
import { DatabaseLatencyProbe } from './database-latency-probe';

jest.mock('postgres', () => ({ __esModule: true, default: jest.fn() }));

function setup(env: Record<string, string | undefined> = {}) {
  const client = Object.assign(
    jest.fn(() => {
      const query = Promise.resolve([]);
      return Object.assign(query, { simple: () => query });
    }),
    { end: jest.fn().mockResolvedValue(undefined) },
  );
  jest.mocked(postgres).mockReturnValue(client as never);
  const config = new ConfigService({
    DATABASE_URL: 'postgres://synthetic:synthetic@localhost:6543/test',
    NODE_ENV: 'production',
    ...env,
  });
  return { probe: new DatabaseLatencyProbe(config), client };
}

describe('detached database latency probe', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('never allocates a client under test or when disabled', () => {
    for (const env of [
      { NODE_ENV: 'test' },
      { DATABASE_LATENCY_PROBE: 'false' },
    ]) {
      const { probe } = setup(env);
      const run = jest.spyOn(probe, 'run');
      probe.onApplicationBootstrap();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('uses one known-cold connection, logs numeric samples and closes it', async () => {
    const { probe, client } = setup();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await probe.run();
    expect(postgres).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ max: 1, prepare: false, connect_timeout: 10 }),
    );
    expect(client).toHaveBeenCalledTimes(7);
    expect(client.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(JSON.parse(log.mock.calls[0][0] as string) as unknown).toMatchObject(
      {
        action: 'database-latency-probe',
        outcome: 'success',
        samples: 3,
        firstSampleMs: expect.any(Number) as unknown,
      },
    );
  });

  it('bounds stalled probes and still closes the connection', async () => {
    jest.useFakeTimers();
    const { probe, client } = setup();
    const stalled = new Promise<never>(() => undefined);
    client.mockReturnValue(Object.assign(stalled, { simple: () => stalled }));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const pending = probe.run();
    await jest.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(warn).toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
