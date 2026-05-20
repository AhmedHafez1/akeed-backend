import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { IntegrationMonthlyUsageRepository } from '../../infrastructure/database/repositories/integration-monthly-usage.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { integrations } from '../../infrastructure/database/schema';
import {
  DashboardDateRange,
  GetVerificationStatsQueryDto,
  GetVerificationsQueryDto,
  PaginatedResponse,
  VerificationListItemDto,
  VerificationStatsDto,
} from '../orders/dto/dashboard.dto';
import { VerificationStatus } from '../../shared/interfaces/verification.interface';
import {
  DEFAULT_BILLING_PLAN_ID,
  isOnboardingBillingPlanId,
  resolveIncludedVerificationsLimit,
} from '../onboarding/onboarding.service.helpers';
import {
  decodeCursor,
  encodeCursor,
} from '../orders/services/pagination.helpers';
import {
  ORDER_ADMIN_PORT,
  type OrderAdminPort,
} from '../../shared/ports/order-admin.port';
import {
  ORDER_TAGGING_PORT,
  type OrderTaggingPort,
} from '../../shared/ports/order-tagging.port';

const ALLOWED_STATUSES: VerificationStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'confirmed',
  'canceled',
  'expired',
  'failed',
  'no_reply',
];

const DEFAULT_STATS_DATE_RANGE: DashboardDateRange = 'last_30_days';
const DEFAULT_AVG_SHIPPING_COST = 3;
const DEFAULT_SHIPPING_CURRENCY = 'USD';
const DEFAULT_AUTO_VERIFY_ENABLED = true;
const DEFAULT_FOLLOW_UP_ENABLED = true;
const DEFAULT_QUIET_HOURS_ENABLED = false;
type IntegrationRecord = typeof integrations.$inferSelect;

interface VerificationStatusCounts {
  total: number;
  confirmed: number;
  canceled: number;
  customerCanceled: number;
  sent: number;
  delivered: number;
  read: number;
}

@Injectable()
export class VerificationsService {
  private readonly logger = new Logger(VerificationsService.name);

  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly monthlyUsageRepo: IntegrationMonthlyUsageRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly ordersRepo: OrdersRepository,
    @Inject(ORDER_ADMIN_PORT)
    private readonly orderAdmin: OrderAdminPort,
    @Inject(ORDER_TAGGING_PORT)
    private readonly orderTagging: OrderTaggingPort,
  ) {}

  async listByOrg(
    orgId: string,
    query: GetVerificationsQueryDto,
  ): Promise<PaginatedResponse<VerificationListItemDto>> {
    const statuses = this.parseStatuses(query.status);
    const dateRange = query.date_range ?? DEFAULT_STATS_DATE_RANGE;
    const now = new Date();
    const filterPeriod = this.resolveDateRangeBounds(dateRange, now);
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);

    const [verifications, activeIntegrations] = await Promise.all([
      this.verificationsRepo.findByOrg(
        orgId,
        statuses,
        {
          startAt: filterPeriod.startAt,
          endAt: filterPeriod.endAt,
        },
        { cursor, limit: limit + 1 },
      ),
      this.integrationsRepo.findActiveByOrg(orgId),
    ]);

    const hasMore = verifications.length > limit;
    const items = hasMore ? verifications.slice(0, limit) : verifications;

    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(items[items.length - 1])
        : null;

    return {
      data: items.map((verification) => ({
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
        last_sent_at: verification.lastSentAt ?? null,
        delivered_at: verification.deliveredAt ?? null,
        read_at: verification.readAt ?? null,
        confirmed_at: verification.confirmedAt ?? null,
        canceled_at: verification.canceledAt ?? null,
        expired_at: verification.expiredAt ?? null,
        no_reply_at: verification.noReplyAt ?? null,
        follow_up_attempts: verification.followUpAttempts ?? 0,
        follow_up_sent_at: verification.followUpSentAt ?? null,
      })),
      next_cursor: nextCursor,
      page_context: {
        automation: this.resolveDashboardAutomationSettings(activeIntegrations),
      },
    };
  }

  async getStatsByOrg(
    orgId: string,
    query: GetVerificationStatsQueryDto,
  ): Promise<VerificationStatsDto> {
    const dateRange = query.date_range ?? DEFAULT_STATS_DATE_RANGE;
    const now = new Date();

    const filterPeriod = this.resolveDateRangeBounds(dateRange, now);

    const [filteredCounts, activeIntegrations] = await Promise.all([
      this.verificationsRepo.getFunnelCountsByOrgAndPeriod(
        orgId,
        filterPeriod.startAt,
        filterPeriod.endAt,
      ),
      this.integrationsRepo.findActiveByOrg(orgId),
    ]);

    const periodStart = this.getBillingPeriodStart(activeIntegrations, now);
    const usage = await this.monthlyUsageRepo.getOrgUsageTotalsForPeriod({
      orgId,
      periodStart,
    });

    const replyRate = this.calculateReplyRate(filteredCounts);
    const confirmationRate = this.calculateConfirmationRate(filteredCounts);
    const usageLimit =
      usage.includedLimit > 0
        ? usage.includedLimit
        : this.resolveFallbackUsageLimit(activeIntegrations);
    const shippingSettings =
      this.resolveDashboardShippingSettings(activeIntegrations);
    const automationSettings =
      this.resolveDashboardAutomationSettings(activeIntegrations);
    const moneySaved = Number(
      (filteredCounts.canceled * shippingSettings.avgShippingCost).toFixed(2),
    );

    return {
      date_range: dateRange,
      automation: automationSettings,
      totals: {
        confirmed: filteredCounts.confirmed,
        canceled: filteredCounts.canceled,
        sent: filteredCounts.sent,
        delivered: filteredCounts.delivered,
        read: filteredCounts.read,
        reply_rate: replyRate,
        confirmation_rate: confirmationRate,
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

  /**
   * Merchant-initiated cancellation for a no_reply verification.
   *
   * 1. Load verification (org-scoped).
   * 2. Idempotent: if already merchant_no_reply canceled, return success.
   * 3. Reject any status other than no_reply.
   * 4. Load the linked order to obtain the Shopify integration.
   * 5. Cancel the order on Shopify first (fail-fast on error).
   * 6. Mark verification as merchant-canceled locally.
   * 7. Apply "Akeed: Canceled" tag (best-effort; log but don't fail).
   */
  async cancelNoReplyOrder(
    orgId: string,
    verificationId: string,
  ): Promise<{
    success: true;
    verificationId: string;
    status: 'canceled';
    alreadyCanceled?: boolean;
    shopifyJobId?: string;
  }> {
    const verification = await this.verificationsRepo.findByIdForOrg(
      verificationId,
      orgId,
    );

    if (!verification) {
      throw new NotFoundException('Verification not found');
    }

    // Idempotent: already merchant_no_reply canceled
    if (
      verification.status === 'canceled' &&
      verification.cancellationSource === 'merchant_no_reply' &&
      verification.merchantCanceledAt
    ) {
      return {
        success: true,
        verificationId,
        status: 'canceled',
        alreadyCanceled: true,
      };
    }

    if (verification.status !== 'no_reply') {
      throw new BadRequestException(
        `Cannot cancel verification with status '${verification.status}'; only 'no_reply' verifications can be canceled`,
      );
    }

    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order) {
      throw new BadRequestException('Cannot cancel: order not found');
    }

    const externalOrderId = order.externalOrderId;

    if (!order.integration) {
      throw new BadRequestException(
        'Cannot cancel: order has no linked Shopify integration',
      );
    }

    if (!externalOrderId) {
      throw new BadRequestException(
        'Cannot cancel: order has no external Shopify order ID',
      );
    }

    const isTestOrder = externalOrderId?.startsWith('akeed-test-') ?? false;
    let shopifyJobId: string | undefined;
    if (!isTestOrder) {
      const integration = order.integration;
      if (!integration) {
        throw new BadRequestException(
          'Cannot cancel: order has no linked Shopify integration',
        );
      }

      // Cancel on Shopify first — if this fails, do NOT update local state
      try {
        const result = await this.orderAdmin.cancelOrder(
          integration,
          externalOrderId,
          'CUSTOMER',
        );
        shopifyJobId = result.jobId;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[CancelNoReply] Shopify cancellation failed for verification ${verificationId}: ${message}`,
        );
        throw new BadGatewayException(
          `Shopify order cancellation failed: ${message}`,
        );
      }
    }

    // Mark as merchant-canceled locally
    const canceledAt = new Date().toISOString();
    const updated = await this.verificationsRepo.markMerchantNoReplyCanceled(
      verificationId,
      orgId,
      canceledAt,
    );

    if (!updated) {
      // Race: verification status changed between our check and the update.
      // Re-check for idempotent merchant_no_reply.
      const reloaded = await this.verificationsRepo.findByIdForOrg(
        verificationId,
        orgId,
      );
      if (
        reloaded?.status === 'canceled' &&
        reloaded.cancellationSource === 'merchant_no_reply'
      ) {
        return {
          success: true,
          verificationId,
          status: 'canceled',
          alreadyCanceled: true,
          shopifyJobId,
        };
      }

      this.logger.warn(
        `[CancelNoReply] Verification ${verificationId} status changed during cancellation (now=${reloaded?.status ?? 'unknown'})`,
      );
      throw new BadRequestException(
        'Verification status changed during cancellation; Shopify order was already canceled — check order status manually',
      );
    }

    if (!isTestOrder) {
      const integration = order.integration;
      if (!integration) {
        throw new BadRequestException(
          'Cannot cancel: order has no linked Shopify integration',
        );
      }

      // Best-effort: add "Akeed: Canceled" tag
      try {
        await this.orderTagging.addOrderTag(
          integration,
          externalOrderId,
          'Akeed: Canceled',
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[CancelNoReply] Failed to add 'Akeed: Canceled' tag for verification ${verificationId}: ${message}`,
        );
      }
    }

    return {
      success: true,
      verificationId,
      status: 'canceled',
      shopifyJobId,
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

  /**
   * Reply rate = (confirmed + customer-canceled) / total.
   * Merchant no-reply cancellations are excluded from the numerator.
   */
  private calculateReplyRate(counts: VerificationStatusCounts): number {
    if (counts.total === 0) {
      return 0;
    }

    return Number(
      (
        ((counts.confirmed + counts.customerCanceled) / counts.total) *
        100
      ).toFixed(1),
    );
  }

  private calculateConfirmationRate(counts: VerificationStatusCounts): number {
    if (counts.total === 0) {
      return 0;
    }

    return Number(((counts.confirmed / counts.total) * 100).toFixed(1));
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
    } else if (dateRange === 'last_3_months') {
      start.setUTCDate(start.getUTCDate() - 89);
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

  /**
   * Derives the current 30-day billing period start from the earliest active
   * integration's activation date, matching Shopify's rolling 30-day cycle.
   * Falls back to the 1st of the current UTC calendar month when no
   * activation date is available.
   */
  private getBillingPeriodStart(
    activeIntegrations: IntegrationRecord[],
    now: Date,
  ): string {
    const activatedAt = activeIntegrations
      .map((i) => i.billingActivatedAt)
      .filter(Boolean)
      .sort()[0];

    if (!activatedAt) {
      const fallback = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      return fallback.toISOString().slice(0, 10);
    }

    const activation = new Date(activatedAt);
    const msPerDay = 86_400_000;
    const elapsedMs = now.getTime() - activation.getTime();
    if (elapsedMs < 0) {
      return activation.toISOString().slice(0, 10);
    }

    const elapsedDays = Math.floor(elapsedMs / msPerDay);
    const completedCycles = Math.floor(elapsedDays / 30);
    const periodStart = new Date(
      activation.getTime() + completedCycles * 30 * msPerDay,
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

  private resolveDashboardAutomationSettings(
    activeIntegrations: IntegrationRecord[],
  ): VerificationStatsDto['automation'] {
    const withSettings = activeIntegrations[0];

    return {
      is_auto_verify_enabled:
        withSettings?.isAutoVerifyEnabled ?? DEFAULT_AUTO_VERIFY_ENABLED,
      follow_up_enabled:
        withSettings?.followUpEnabled ?? DEFAULT_FOLLOW_UP_ENABLED,
      quiet_hours_enabled:
        withSettings?.quietHoursEnabled ?? DEFAULT_QUIET_HOURS_ENABLED,
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
