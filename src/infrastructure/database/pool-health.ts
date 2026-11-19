import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import { DatabaseTimeoutError } from '../../shared/errors/database-timeout.error';
import { usesTransactionPooler } from './database.provider';

export type PingOutcome = 'ok' | 'timeout' | 'error';

export interface PingResult {
  outcome: PingOutcome;
  elapsedMs: number;
  error?: unknown;
}

/**
 * Runs a trivial statement against a deadline of its own. Only a missed
 * deadline is a `timeout`: an error that comes back means the driver is still
 * talking to something, which a restart would not improve.
 */
export async function pingWithin(
  run: () => Promise<unknown>,
  timeoutMs: number,
): Promise<PingResult> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const settled = await Promise.race([
      run().then(() => 'ok' as const),
      expired,
    ]);
    return { outcome: settled, elapsedMs: performance.now() - startedAt };
  } catch (error) {
    return {
      outcome: error instanceof DatabaseTimeoutError ? 'timeout' : 'error',
      elapsedMs: performance.now() - startedAt,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pings through a new one-connection client, bypassing the application pool.
 * When the pool misses its deadline but this answers, the database is fine
 * and the pool's own connections are stuck.
 */
export async function pingWithFreshClient(
  databaseUrl: string,
  timeoutMs: number,
): Promise<PingResult> {
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: !usesTransactionPooler(databaseUrl),
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    idle_timeout: 1,
    max_lifetime: 60,
  });
  try {
    return await pingWithin(() => client`select 1`.simple(), timeoutMs);
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

/**
 * Replaces the application pool in process. `allowed` says whether a
 * replacement may happen now: false while one is running or within the
 * cooldown after the last one.
 */
export interface PoolRecycler {
  allowed: () => boolean;
  recycle: () => void;
}

export interface PoolWatchdogDeps {
  pingPool: () => Promise<PingResult>;
  pingFresh: () => Promise<PingResult>;
  failuresBeforeExit: number;
  onCheck: (event: PoolWatchdogEvent) => void;
  exit: () => void;
  /** Without it a wedged pool always ends the process. */
  recycler?: PoolRecycler;
}

export type PoolWatchdogEvent =
  | { kind: 'recovered'; missedChecks: number }
  | { kind: 'pool-error'; ping: PingResult }
  | { kind: 'pool-timeout'; ping: PingResult; consecutive: number }
  | {
      kind: 'pool-recycled';
      consecutive: number;
      fresh: PingResult;
    }
  | {
      kind: 'pool-wedged';
      consecutive: number;
      fresh: PingResult;
    }
  | {
      kind: 'database-unreachable';
      consecutive: number;
      fresh: PingResult;
    };

/**
 * Counts consecutive pool pings that miss their deadline. At the threshold it
 * pings through a fresh client. If that answers, the pool is wedged: it is
 * replaced in process when a replacement is allowed, and otherwise (it was
 * replaced moments ago and is stuck again) the process exits for the platform
 * to restart it. If the fresh client fails too, the database or network is
 * down, neither would help, and checking continues.
 */
export class PoolWatchdog {
  private consecutive = 0;

  constructor(private readonly deps: PoolWatchdogDeps) {}

  get consecutiveTimeouts(): number {
    return this.consecutive;
  }

  async check(): Promise<void> {
    const ping = await this.deps.pingPool();
    if (ping.outcome === 'ok') {
      if (this.consecutive > 0) {
        this.deps.onCheck({
          kind: 'recovered',
          missedChecks: this.consecutive,
        });
      }
      this.consecutive = 0;
      return;
    }
    if (ping.outcome === 'error') {
      this.consecutive = 0;
      this.deps.onCheck({ kind: 'pool-error', ping });
      return;
    }

    this.consecutive += 1;
    this.deps.onCheck({
      kind: 'pool-timeout',
      ping,
      consecutive: this.consecutive,
    });
    if (this.consecutive < this.deps.failuresBeforeExit) return;

    const fresh = await this.deps.pingFresh();
    if (fresh.outcome === 'ok') {
      const recycler = this.deps.recycler;
      if (recycler?.allowed()) {
        this.deps.onCheck({
          kind: 'pool-recycled',
          consecutive: this.consecutive,
          fresh,
        });
        this.consecutive = 0;
        recycler.recycle();
        return;
      }
      this.deps.onCheck({
        kind: 'pool-wedged',
        consecutive: this.consecutive,
        fresh,
      });
      this.deps.exit();
      return;
    }
    this.deps.onCheck({
      kind: 'database-unreachable',
      consecutive: this.consecutive,
      fresh,
    });
  }
}

export interface DeadlineBurstDeps {
  threshold: number;
  windowMs: number;
  now: () => number;
  pingFresh: () => Promise<PingResult>;
  recycler: PoolRecycler;
  onBurst: (event: DeadlineBurstEvent) => void;
}

export type DeadlineBurstEvent =
  | { kind: 'recycle'; deadlines: number; fresh: PingResult }
  | { kind: 'database-unreachable'; deadlines: number; fresh: PingResult };

/**
 * Catches a pool that is only partly stuck. Each missed statement or
 * transaction deadline is recorded; when `threshold` of them fall within
 * `windowMs` and a fresh client answers, the pool is replaced. Slow queries
 * on a healthy database can trigger it too, which costs a set of new
 * connections: statements already running finish on the old ones. While a
 * replacement is not allowed (running, or within its cooldown) deadlines are
 * still recorded but nothing happens.
 */
export class DeadlineBurstDetector {
  private deadlines: number[] = [];
  private checking = false;

  constructor(private readonly deps: DeadlineBurstDeps) {}

  get recentDeadlines(): number {
    return this.deadlines.length;
  }

  async record(): Promise<void> {
    const now = this.deps.now();
    this.deadlines = this.deadlines.filter(
      (at) => now - at < this.deps.windowMs,
    );
    this.deadlines.push(now);
    if (this.deadlines.length < this.deps.threshold) return;
    if (this.checking || !this.deps.recycler.allowed()) return;

    this.checking = true;
    const deadlines = this.deadlines.length;
    try {
      const fresh = await this.deps.pingFresh();
      if (fresh.outcome !== 'ok') {
        this.deps.onBurst({ kind: 'database-unreachable', deadlines, fresh });
        return;
      }
      // Another trigger may have replaced the pool while the ping ran.
      if (!this.deps.recycler.allowed()) return;
      this.deadlines = [];
      this.deps.onBurst({ kind: 'recycle', deadlines, fresh });
      this.deps.recycler.recycle();
    } finally {
      this.checking = false;
    }
  }
}
