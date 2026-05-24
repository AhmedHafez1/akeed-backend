import { Inject, Injectable, Logger } from '@nestjs/common';
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
        `Health check database ping failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
