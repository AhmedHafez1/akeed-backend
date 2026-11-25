import type { Logger } from '@nestjs/common';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  DeadlineBurstDetector,
  type DeadlineBurstEvent,
  type PingResult,
  type PoolRecycler,
} from './pool-health';
import type { SwappableClient } from './swappable-client';

export const DATABASE_POOL_CONTROL = Symbol('DATABASE_POOL_CONTROL');

export type RecycleTrigger = 'wedged' | 'deadline-burst';

export interface DatabasePoolControlOptions {
  enabled: boolean;
  cooldownMs: number;
  /** Seconds running statements may keep a replaced client before it is destroyed. */
  drainTimeoutSeconds: number;
  deadlineThreshold: number;
  deadlineWindowMs: number;
  pingFresh: () => Promise<PingResult>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  now?: () => number;
}

const MODULE = 'DatabasePoolControl';

function rounded(ping: PingResult): Record<string, unknown> {
  return {
    pingOutcome: ping.outcome,
    elapsedMs: Math.round(ping.elapsedMs),
    ...(ping.error === undefined ? {} : normalizeError(ping.error)),
  };
}

/**
 * Owns the replaceable application pool. Two triggers may replace it: the
 * pool watchdog when every connection is stuck, and a burst of missed
 * deadlines when only some are. Replacements are at least `cooldownMs`
 * apart; within that window the watchdog ends the process instead.
 */
export class DatabasePoolControl<T extends object = object> {
  private lastRecycledAt: number | undefined;
  private readonly now: () => number;
  private readonly detector: DeadlineBurstDetector;

  constructor(
    private readonly pool: SwappableClient<T>,
    private readonly options: DatabasePoolControlOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.detector = new DeadlineBurstDetector({
      threshold: options.deadlineThreshold,
      windowMs: options.deadlineWindowMs,
      now: this.now,
      pingFresh: options.pingFresh,
      recycler: this.recycler('deadline-burst'),
      onBurst: (event) => this.reportBurst(event),
    });
  }

  /** The handle Drizzle and the deadline wrappers hold. */
  get client(): T {
    return this.pool.client;
  }

  get generation(): number {
    return this.pool.generation;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  allowed(): boolean {
    if (!this.options.enabled) return false;
    return (
      this.lastRecycledAt === undefined ||
      this.now() - this.lastRecycledAt >= this.options.cooldownMs
    );
  }

  recycler(trigger: RecycleTrigger): PoolRecycler {
    return {
      allowed: () => this.allowed(),
      recycle: () => {
        this.recycle(trigger);
      },
    };
  }

  /** Replaces the pool when allowed; returns whether it did. */
  recycle(trigger: RecycleTrigger): boolean {
    if (!this.allowed()) return false;
    this.lastRecycledAt = this.now();
    const { generation, drained } = this.pool.replace(
      this.options.drainTimeoutSeconds,
    );
    this.options.logger.warn(
      buildBackendLog(MODULE, {
        action: 'database-pool-recycle',
        outcome: 'success',
        trigger,
        generation,
        drainTimeoutSeconds: this.options.drainTimeoutSeconds,
      }),
    );
    void drained.then((outcome) =>
      this.options.logger.log(
        buildBackendLog(MODULE, {
          action: 'database-pool-recycle-drained',
          outcome: outcome === 'ended' ? 'success' : 'failure',
          generation: generation - 1,
        }),
      ),
    );
    return true;
  }

  /**
   * Called for every missed statement or transaction deadline. Settles, and
   * never rejects, once any replacement it causes has happened.
   */
  noteDeadline(): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    return this.detector.record().catch((error: unknown) =>
      this.options.logger.error(
        buildBackendLog(MODULE, {
          action: 'database-deadline-burst',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      ),
    );
  }

  endAll(timeoutSeconds: number): Promise<void> {
    return this.pool.endAll(timeoutSeconds);
  }

  private reportBurst(event: DeadlineBurstEvent): void {
    if (event.kind === 'recycle') {
      this.options.logger.warn(
        buildBackendLog(MODULE, {
          action: 'database-deadline-burst',
          outcome: 'failure',
          reason: 'pool-partly-stuck',
          deadlinesInWindow: event.deadlines,
          freshClient: rounded(event.fresh),
        }),
      );
      return;
    }
    this.options.logger.error(
      buildBackendLog(MODULE, {
        action: 'database-deadline-burst',
        outcome: 'failure',
        reason: 'database-unreachable',
        severity: 'critical',
        deadlinesInWindow: event.deadlines,
        freshClient: rounded(event.fresh),
      }),
    );
  }
}
