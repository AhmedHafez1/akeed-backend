import { Injectable, Logger } from '@nestjs/common';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { PublicStatsDto } from './dto/public-stats.dto';

export const PUBLIC_STATS_CACHE_TTL_MS = 5 * 60_000;

/** Aggregates the public site shows. Never carries tenant or customer data. */
@Injectable()
export class PublicStatsService {
  private readonly logger = new Logger(PublicStatsService.name);
  private cached: { value: PublicStatsDto; expiresAt: number } | null = null;
  private inFlight: Promise<PublicStatsDto> | null = null;

  constructor(
    private readonly verifications: VerificationsRepository,
    private readonly integrations: IntegrationsRepository,
  ) {}

  async getStats(now: number = Date.now()): Promise<PublicStatsDto> {
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;
    // Concurrent misses share one query instead of each scanning the table.
    this.inFlight ??= this.load(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(now: number): Promise<PublicStatsDto> {
    const startedAt = Date.now();
    try {
      const [total, activeStores] = await Promise.all([
        this.verifications.countCustomerConfirmedProductionOrders(),
        this.integrations.countActiveStores().catch((error: unknown) => {
          this.logger.warn(
            buildBackendLog(PublicStatsService.name, {
              action: 'public_stats_store_count',
              outcome: 'failure',
              ...normalizeError(error),
            }),
          );
          return null;
        }),
      ]);
      const value: PublicStatsDto = {
        confirmed_orders_total: total,
        active_stores_total: activeStores,
        as_of: new Date(now).toISOString(),
      };
      this.cached = { value, expiresAt: now + PUBLIC_STATS_CACHE_TTL_MS };
      this.logger.log(
        buildBackendLog(PublicStatsService.name, {
          action: 'public_stats_refresh',
          outcome: 'success',
          durationMs: Date.now() - startedAt,
          confirmedOrdersTotal: total,
          activeStoresTotal: activeStores,
        }),
      );
      return value;
    } catch (error: unknown) {
      this.logger.error(
        buildBackendLog(PublicStatsService.name, {
          action: 'public_stats_refresh',
          outcome: 'failure',
          durationMs: Date.now() - startedAt,
          ...normalizeError(error),
        }),
      );
      throw error;
    }
  }
}
