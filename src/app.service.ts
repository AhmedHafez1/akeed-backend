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
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from './infrastructure/database';

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

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

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

  async getHealth(): Promise<HealthCheckDto> {
    const timestamp = new Date().toISOString();

    try {
      await this.db.execute(sql`SELECT 1`);
      return {
        status: 'ok',
        timestamp,
        checks: {
          database: 'ok',
        },
      };
    } catch (error) {
      this.logger.error(
        buildBackendLog('AppService', {
          action: 'getHealth.databasePing',
          outcome: 'failure',
          ...normalizeError(error),
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
}
