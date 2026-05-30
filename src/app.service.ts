import { Inject, Injectable, Logger } from '@nestjs/common';
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
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

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
