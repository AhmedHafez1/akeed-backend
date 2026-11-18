import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  buildBackendLog,
  normalizeError,
} from './shared/logging/backend-log.util';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from './infrastructure/database';
import { pingWithin } from './infrastructure/database/pool-health';
import { readDatabaseResilienceConfig } from './shared/config/database-resilience.config';

export interface HealthCheckDto {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    database: 'ok' | 'error';
  };
}

@Injectable()
export class AppService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(AppService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly configService: ConfigService,
  ) {}

  // Queue workers have stopped by now; the HTTP server closes next. The line
  // shows a deploy's old instance shut down on its signal rather than being
  // killed.
  beforeApplicationShutdown(signal?: string): void {
    this.logger.log(
      buildBackendLog('AppService', {
        action: 'app-shutdown',
        outcome: 'success',
        signal: signal ?? null,
      }),
    );
  }

  getHello(): string {
    return 'Hello World!';
  }

  /**
   * Pings through the application pool, the one requests use, against its
   * own deadline: a pool whose connections are stuck answers 503 here instead
   * of holding the health check open.
   */
  async getHealth(): Promise<HealthCheckDto> {
    const timestamp = new Date().toISOString();
    const { pingTimeoutMs } = readDatabaseResilienceConfig(this.configService);
    const ping = await pingWithin(
      () => this.db.execute(sql`SELECT 1`),
      pingTimeoutMs,
    );

    if (ping.outcome === 'ok') {
      return {
        status: 'ok',
        timestamp,
        checks: {
          database: 'ok',
        },
      };
    }

    this.logger.error(
      buildBackendLog('AppService', {
        action: 'getHealth.databasePing',
        outcome: 'failure',
        reason: ping.outcome,
        elapsedMs: Math.round(ping.elapsedMs),
        pingTimeoutMs,
        ...(ping.error === undefined ? {} : normalizeError(ping.error)),
      }),
    );

    return {
      status: 'degraded',
      timestamp,
      checks: {
        database: 'error',
      },
    };
  }
}
