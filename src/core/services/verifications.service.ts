import { BadRequestException, Injectable } from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { integrations } from '../../infrastructure/database/schema';
import {
  DashboardDateRange,
  GetVerificationStatsQueryDto,
  GetVerificationsQueryDto,
  VerificationListItemDto,
  VerificationStatsDto,
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
const DEFAULT_AVG_SHIPPING_COST = 3;
const DEFAULT_SHIPPING_CURRENCY = 'USD';
type IntegrationRecord = typeof integrations.$inferSelect;

interface VerificationStatusCounts {
  total: number;
  confirmed: number;
  canceled: number;
  sent: number;
  delivered: number;
  read: number;
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
    const periodStart = this.getCurrentMonthStartDate(now);

    const [filteredCounts, usage, activeIntegrations] = await Promise.all([
      this.verificationsRepo.getStatusCountsByOrgAndPeriod(
        orgId,
        filterPeriod.startAt,
        filterPeriod.endAt,
      ),
      this.monthlyUsageRepo.getOrgUsageTotalsForPeriod({
        orgId,
        periodStart,
      }),
      this.integrationsRepo.findActiveByOrg(orgId),
    ]);

    const replyRate = this.calculateReplyRate(filteredCounts);
    const usageLimit =
      usage.includedLimit > 0
        ? usage.includedLimit
        : this.resolveFallbackUsageLimit(activeIntegrations);
    const shippingSettings =
      this.resolveDashboardShippingSettings(activeIntegrations);
    const moneySaved = Number(
      (filteredCounts.canceled * shippingSettings.avgShippingCost).toFixed(2),
    );

    return {
      date_range: dateRange,
      totals: {
        confirmed: filteredCounts.confirmed,
        canceled: filteredCounts.canceled,
        sent: filteredCounts.sent,
        delivered: filteredCounts.delivered,
        read: filteredCounts.read,
        reply_rate: replyRate,
      },
      usage: {
        used: usage.consumedCount,
        limit: usageLimit,
      },
      savings: {
        avg_shipping_cost: shippingSettings.avgShippingCost,
        currency: shippingSettings.currency,
        money_saved: moneySaved,
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

  private calculateReplyRate(counts: VerificationStatusCounts): number {
    if (counts.total === 0) {
      return 0;
    }

    return Number(
      (((counts.confirmed + counts.canceled) / counts.total) * 100).toFixed(1),
    );
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

  private getCurrentMonthStartDate(now: Date): string {
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    return periodStart.toISOString().slice(0, 10);
  }

  private resolveDashboardShippingSettings(
    activeIntegrations: IntegrationRecord[],
  ): {
    currency: string;
    avgShippingCost: number;
  } {
    const withSettings = activeIntegrations.find((integration) => {
      return (
        typeof integration.shippingCurrency === 'string' ||
        typeof integration.avgShippingCost === 'string' ||
        typeof integration.avgShippingCost === 'number'
      );
    });

    const currency = (
      withSettings?.shippingCurrency ?? DEFAULT_SHIPPING_CURRENCY
    )
      .trim()
      .toUpperCase();

    const rawAvgShippingCost =
      withSettings?.avgShippingCost ?? DEFAULT_AVG_SHIPPING_COST;

    const parsedAvgShippingCost =
      typeof rawAvgShippingCost === 'number'
        ? rawAvgShippingCost
        : typeof rawAvgShippingCost === 'string'
          ? Number.parseFloat(rawAvgShippingCost)
          : Number.NaN;

    const avgShippingCost =
      Number.isFinite(parsedAvgShippingCost) && parsedAvgShippingCost >= 0
        ? Number(parsedAvgShippingCost.toFixed(2))
        : DEFAULT_AVG_SHIPPING_COST;

    return {
      currency,
      avgShippingCost,
    };
  }

  private resolveFallbackUsageLimit(
    activeIntegrations: IntegrationRecord[],
  ): number {
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
