import type { Sql } from 'postgres';
import { probeDatabaseLatency, shouldRunLatencyProbe } from './latency-probe';

function fakeSql() {
  const calls = { simple: 0, extended: 0 };
  const client = (_strings: TemplateStringsArray, ...params: unknown[]) => {
    if (params.length > 0) calls.extended += 1;
    const query = Promise.resolve([]) as unknown as Promise<unknown[]> & {
      simple: () => Promise<unknown[]>;
    };
    query.simple = () => {
      calls.simple += 1;
      return Promise.resolve([]);
    };
    return query;
  };
  return { client: client as unknown as Sql, calls };
}

describe('shouldRunLatencyProbe', () => {
  it('never runs under test and can be switched off', () => {
    expect(shouldRunLatencyProbe({ NODE_ENV: 'test' })).toBe(false);
    expect(
      shouldRunLatencyProbe({
        NODE_ENV: 'production',
        DATABASE_LATENCY_PROBE: ' FALSE ',
      }),
    ).toBe(false);
  });

  it('runs by default elsewhere', () => {
    expect(shouldRunLatencyProbe({ NODE_ENV: 'production' })).toBe(true);
    expect(shouldRunLatencyProbe({})).toBe(true);
    expect(
      shouldRunLatencyProbe({
        NODE_ENV: 'development',
        DATABASE_LATENCY_PROBE: 'true',
      }),
    ).toBe(true);
  });
});

describe('probeDatabaseLatency', () => {
  it('measures the first statement, then medians of each protocol', async () => {
    const { client, calls } = fakeSql();
    const result = await probeDatabaseLatency(client, 3);
    expect(calls).toEqual({ simple: 4, extended: 3 });
    expect(result.samples).toBe(3);
    expect(result.firstSampleMs).toBeGreaterThanOrEqual(0);
    expect(result.protocolOverheadMs).toBeCloseTo(
      result.extendedMs - result.simpleMs,
      6,
    );
  });

  it('takes at least one sample', async () => {
    const { client, calls } = fakeSql();
    const result = await probeDatabaseLatency(client, 0);
    expect(result.samples).toBe(1);
    expect(calls).toEqual({ simple: 2, extended: 1 });
  });
});
