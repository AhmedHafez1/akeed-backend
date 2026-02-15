import { BadRequestException, Injectable } from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import {
  DashboardDateRange,
  GetVerificationStatsQueryDto,
  GetVerificationsQueryDto,
  VerificationListItemDto,
  VerificationStatsDto,
  VerificationStatsTrendDto,
} from '../dto/dashboard.dto';
import { VerificationStatus } from '../interfaces/verification.interface';
import {
  DEFAULT_BILLING_PLAN_ID,
  isOnboardingBillingPlanId,
  resolveIncludedVerificationsLimit,
} from './onboarding.service.helpers';

const ALLOWED_STATUSES: VerificationStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'confirmed',
  'canceled',
  'expired',
  'failed',
];

const DEFAULT_STATS_DATE_RANGE: DashboardDateRange = 'last_30_days';

interface VerificationStatusCounts {
  total: number;
  pending: number;
  confirmed: number;
  canceled: number;
  expired: number;
}

@Injectable()
export class VerificationsService {
  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly monthlyUsageRepo: IntegrationMonthlyUsageRepository,
    private readonly integrationsRepo: IntegrationsRepository,
  ) {}

  async listByOrg(
    orgId: string,
    query: GetVerificationsQueryDto,
  ): Promise<VerificationListItemDto[]> {
    const statuses = this.parseStatuses(query.status);
    const verifications = await this.verificationsRepo.findByOrg(
      orgId,
      statuses,
    );

    return verifications.map((verification) => ({
      id: verification.id,
      status: verification.status ?? 'pending',
      order_id: verification.orderId,
      order_number: verification.order?.orderNumber ?? null,
      customer_name: verification.order?.customerName ?? null,
      customer_phone: verification.order?.customerPhone ?? null,
      total_price: verification.order?.totalPrice
        ? verification.order.totalPrice.toString()
        : null,
      currency: verification.order?.currency ?? null,
      created_at: verification.createdAt ?? null,
    }));
  }

  async getStatsByOrg(
    orgId: string,
    query: GetVerificationStatsQueryDto,
  ): Promise<VerificationStatsDto> {
    const dateRange = query.date_range ?? DEFAULT_STATS_DATE_RANGE;
    const now = new Date();

    const filterPeriod = this.resolveDateRangeBounds(dateRange, now);
    const currentMonthPeriod = this.resolveCurrentMonthBounds(now);
    const previousMonthPeriod = this.resolvePreviousMonthBounds(now);
    const periodStart = currentMonthPeriod.startAt.slice(0, 10);

    const [filteredCounts, currentMonthCounts, previousMonthCounts, usage] =
      await Promise.all([
        this.verificationsRepo.getStatusCountsByOrgAndPeriod(
          orgId,
          filterPeriod.startAt,
          filterPeriod.endAt,
        ),
        this.verificationsRepo.getStatusCountsByOrgAndPeriod(
          orgId,
          currentMonthPeriod.startAt,
          currentMonthPeriod.endAt,
        ),
        this.verificationsRepo.getStatusCountsByOrgAndPeriod(
          orgId,
          previousMonthPeriod.startAt,
          previousMonthPeriod.endAt,
        ),
        this.monthlyUsageRepo.getOrgUsageTotalsForPeriod({
          orgId,
          periodStart,
        }),
      ]);

    const verificationRate = this.calculateVerificationRate(filteredCounts);
    const usageLimit =
      usage.includedLimit > 0
        ? usage.includedLimit
        : await this.resolveFallbackUsageLimit(orgId);

    return {
      date_range: dateRange,
      totals: {
        total: filteredCounts.total,
        pending: filteredCounts.pending,
        confirmed: filteredCounts.confirmed,
        canceled: filteredCounts.canceled,
        expired: filteredCounts.expired,
        verification_rate: verificationRate,
      },
      monthly_trends: {
        total: this.buildTrend(
          currentMonthCounts.total,
          previousMonthCounts.total,
        ),
        pending: this.buildTrend(
          currentMonthCounts.pending,
          previousMonthCounts.pending,
        ),
        confirmed: this.buildTrend(
          currentMonthCounts.confirmed,
          previousMonthCounts.confirmed,
        ),
        canceled: this.buildTrend(
          currentMonthCounts.canceled,
          previousMonthCounts.canceled,
        ),
        expired: this.buildTrend(
          currentMonthCounts.expired,
          previousMonthCounts.expired,
        ),
      },
      usage: {
        used: usage.consumedCount,
        limit: usageLimit,
      },
    };
  }

  private parseStatuses(input?: string): VerificationStatus[] | undefined {
    if (!input) return undefined;

    const statuses = input
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean) as VerificationStatus[];

    if (statuses.length === 0) return undefined;

    const invalid = statuses.filter(
      (status) => !ALLOWED_STATUSES.includes(status),
    );

    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid status filter: ${invalid.join(', ')}`,
      );
    }

    return statuses;
  }

  private calculateVerificationRate(counts: VerificationStatusCounts): number {
    if (counts.total === 0) {
      return 0;
    }

    return Number(((counts.confirmed / counts.total) * 100).toFixed(1));
  }

  private buildTrend(
    currentMonth: number,
    previousMonth: number,
  ): VerificationStatsTrendDto {
    const change = currentMonth - previousMonth;
    const changePercentage =
      previousMonth === 0
        ? null
        : Number(((change / previousMonth) * 100).toFixed(1));

    return {
      current_month: currentMonth,
      previous_month: previousMonth,
      change,
      change_percentage: changePercentage,
    };
  }

  private resolveDateRangeBounds(
    dateRange: DashboardDateRange,
    now: Date,
  ): { startAt: string; endAt: string } {
    const end = this.getStartOfNextUtcDay(now);
    const currentDayStart = this.getStartOfUtcDay(now);
    const start = new Date(currentDayStart);

    if (dateRange === 'last_7_days') {
      start.setUTCDate(start.getUTCDate() - 6);
    } else if (dateRange === 'last_30_days') {
      start.setUTCDate(start.getUTCDate() - 29);
    }

    return {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
    };
  }

  private resolveCurrentMonthBounds(now: Date): {
    startAt: string;
    endAt: string;
  } {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );

    return {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
    };
  }

  private resolvePreviousMonthBounds(now: Date): {
    startAt: string;
    endAt: string;
  } {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    return {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
    };
  }

  private getStartOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private getStartOfNextUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 1,
      ),
    );
  }

  private async resolveFallbackUsageLimit(orgId: string): Promise<number> {
    const activeIntegrations =
      await this.integrationsRepo.findActiveByOrg(orgId);

    if (activeIntegrations.length === 0) {
      return resolveIncludedVerificationsLimit(DEFAULT_BILLING_PLAN_ID);
    }

    return activeIntegrations.reduce((total, integration) => {
      const planId =
        integration.billingPlanId &&
        isOnboardingBillingPlanId(integration.billingPlanId)
          ? integration.billingPlanId
          : DEFAULT_BILLING_PLAN_ID;

      return total + resolveIncludedVerificationsLimit(planId);
    }, 0);
  }
}
