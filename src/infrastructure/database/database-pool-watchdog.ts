import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { readDatabaseResilienceConfig } from '../../shared/config/database-resilience.config';
import { DRIZZLE, type DrizzleDB } from './database.provider';
import {
  DATABASE_POOL_CONTROL,
  type DatabasePoolControl,
} from './database-pool-control';
import {
  pingWithFreshClient,
  pingWithin,
  PoolWatchdog,
  type PingResult,
  type PoolWatchdogEvent,
} from './pool-health';

function rounded(ping: PingResult): Record<string, unknown> {
  return {
    pingOutcome: ping.outcome,
    elapsedMs: Math.round(ping.elapsedMs),
    ...(ping.error === undefined ? {} : normalizeError(ping.error)),
  };
}

/**
 * Pings the application pool on an interval. When the pool keeps missing its
 * deadline while the database itself answers, the pool is replaced in
 * process. If it is stuck again within the replacement cooldown, the process
 * ends: it would stay alive and keep logging in that state, so nothing else
 * would restart it. The exit is immediate: a graceful shutdown would wait on
 * the same stuck connections. Queue jobs left active are retried after restart.
 */
@Injectable()
export class DatabasePoolWatchdog
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DatabasePoolWatchdog.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Replaced in tests. */
  exitProcess: () => void = () => process.exit(1);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly configService: ConfigService,
    @Inject(DATABASE_POOL_CONTROL)
    private readonly pool: Pick<DatabasePoolControl, 'enabled' | 'recycler'>,
  ) {}

  onApplicationBootstrap(): void {
    const config = readDatabaseResilienceConfig(this.configService);
    if (!config.watchdogEnabled) return;
    const databaseUrl = this.configService.getOrThrow<string>('DATABASE_URL');
    const watchdog = new PoolWatchdog({
      pingPool: () =>
        pingWithin(() => this.db.execute(sql`select 1`), config.pingTimeoutMs),
      pingFresh: () => pingWithFreshClient(databaseUrl, config.pingTimeoutMs),
      failuresBeforeExit: config.watchdogFailures,
      onCheck: (event) => this.report(event, config.pingTimeoutMs),
      exit: () => {
        this.stopped = true;
        this.exitProcess();
      },
      recycler: this.pool.enabled ? this.pool.recycler('wedged') : undefined,
    });
    this.logger.log(
      buildBackendLog(DatabasePoolWatchdog.name, {
        action: 'database-pool-watchdog-start',
        outcome: 'success',
        intervalMs: config.watchdogIntervalMs,
        pingTimeoutMs: config.pingTimeoutMs,
        failuresBeforeExit: config.watchdogFailures,
        poolRecycle: this.pool.enabled,
      }),
    );
    this.schedule(watchdog, config.watchdogIntervalMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  // Each check is scheduled after the previous one settles, so a slow check
  // never overlaps the next.
  private schedule(watchdog: PoolWatchdog, intervalMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      watchdog
        .check()
        .catch((error: unknown) =>
          this.logger.error(
            buildBackendLog(DatabasePoolWatchdog.name, {
              action: 'database-pool-watchdog',
              outcome: 'failure',
              ...normalizeError(error),
            }),
          ),
        )
        .finally(() => this.schedule(watchdog, intervalMs));
    }, intervalMs);
    this.timer.unref?.();
  }

  private report(event: PoolWatchdogEvent, pingTimeoutMs: number): void {
    const action = 'database-pool-watchdog';
    switch (event.kind) {
      case 'recovered':
        this.logger.log(
          buildBackendLog(DatabasePoolWatchdog.name, {
            action,
            outcome: 'success',
            reason: 'recovered',
            missedChecks: event.missedChecks,
          }),
        );
        return;
      case 'pool-error':
        this.logger.warn(
          buildBackendLog(DatabasePoolWatchdog.name, {
            action,
            outcome: 'failure',
            reason: 'error',
            ...rounded(event.ping),
          }),
        );
        return;
      case 'pool-timeout':
        this.logger.warn(
          buildBackendLog(DatabasePoolWatchdog.name, {
            action,
            outcome: 'failure',
            reason: 'timeout',
            consecutive: event.consecutive,
            pingTimeoutMs,
            ...rounded(event.ping),
          }),
        );
        return;
      case 'pool-recycled':
        this.logger.warn(
          buildBackendLog(DatabasePoolWatchdog.name, {
            action: 'database-pool-wedged',
            outcome: 'failure',
            reason: 'pool-wedged',
            processAction: 'recycle',
            consecutive: event.consecutive,
            pingTimeoutMs,
            freshClient: rounded(event.fresh),
          }),
        );
        return;
      case 'pool-wedged':
        this.logger.fatal(
          buildBackendLog(DatabasePoolWatchdog.name, {
            action: 'database-pool-wedged',
            outcome: 'failure',
            reason: 'pool-wedged',
            processAction: 'exit',
            severity: 'critical',
            consecutive: event.consecutive,
            pingTimeoutMs,
            freshClient: rounded(event.fresh),
          }),
        );
        return;
      case 'database-unreachable':
        this.logger.error(
          buildBackendLog(DatabasePoolWatchdog.name, {
            action,
            outcome: 'failure',
            reason: 'database-unreachable',
            severity: 'critical',
            consecutive: event.consecutive,
            pingTimeoutMs,
            freshClient: rounded(event.fresh),
          }),
        );
        return;
    }
  }
}
