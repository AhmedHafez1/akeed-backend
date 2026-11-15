import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';

export interface LatencyProbeResult {
  /** Median `select 1` over the simple protocol: one network round trip. */
  simpleMs: number;
  /**
   * Median parameterized `select $1::int` over the extended protocol. With
   * prepared statements off this is Describe then Bind/Execute: two round
   * trips, so the difference from `simpleMs` is the protocol's cost.
   */
  extendedMs: number;
  protocolOverheadMs: number;
  /** The very first statement, which also opens the pooled connection. */
  firstSampleMs: number;
  samples: number;
}

export function shouldRunLatencyProbe(env: {
  NODE_ENV?: string;
  DATABASE_LATENCY_PROBE?: string;
}): boolean {
  if (env.NODE_ENV === 'test') return false;
  return env.DATABASE_LATENCY_PROBE?.trim().toLowerCase() !== 'false';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function timed(run: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  await run();
  return performance.now() - startedAt;
}

/**
 * Separates network latency, protocol round trips and connection setup from
 * SQL execution, which `pg_stat_statements` already reports. Statements run
 * one after another so the pool reuses one connection after the first.
 */
export async function probeDatabaseLatency(
  client: Sql,
  samples = 3,
): Promise<LatencyProbeResult> {
  const count = Math.max(1, Math.floor(samples));
  const firstSampleMs = await timed(() => client`select 1`.simple());
  const simple: number[] = [];
  for (let index = 0; index < count; index += 1)
    simple.push(await timed(() => client`select 1`.simple()));
  const extended: number[] = [];
  for (let index = 0; index < count; index += 1)
    extended.push(await timed(() => client`select ${1}::int`));
  const simpleMs = median(simple);
  const extendedMs = median(extended);
  return {
    simpleMs,
    extendedMs,
    protocolOverheadMs: extendedMs - simpleMs,
    firstSampleMs,
    samples: count,
  };
}
