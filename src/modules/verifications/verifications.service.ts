import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { integrations } from '../../infrastructure/database/schema';
import {
  DashboardDateRange,
  DashboardSourceState,
  GetVerificationStatsQueryDto,
  GetVerificationsQueryDto,
  PaginatedResponse,
  VerificationListItemDto,
  VerificationStatsDto,
} from '../orders/dto/dashboard.dto';
import { VerificationStatus } from '../../shared/interfaces/verification.interface';
import {
  canRetryVerification,
  readVerificationReason,
  type VerificationRowCapability,
} from '../../shared/verification/verification-row-actions';
import {
  resolveDashboardDateRangeBounds,
  resolveDashboardTimezone,
} from '../orders/services/dashboard-date-range';

import {
  decodeCursor,
  encodeCursor,
} from '../orders/services/pagination.helpers';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import type {
  CancelOrderResponse,
  CommerceOutcomeOperationResult,
} from '../../shared/commerce/commerce-outcome';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import { isSyntheticOrder } from '../../shared/commerce/synthetic-order';

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
const DEFAULT_REPORTING_TIMEZONE = 'UTC';
const DEFAULT_AVG_SHIPPING_COST = 3;
const DEFAULT_SHIPPING_CURRENCY = 'USD';
const DEFAULT_QUIET_HOURS_ENABLED = false;
type IntegrationRecord = typeof integrations.$inferSelect;

interface VerificationStatusCounts {
  total: number;
  inProgress: number;
  needsAttention: number;
  pending: number;
  failed: number;
  awaitingReply: number;
  confirmed: number;
  canceled: number;
  customerCanceled: number;
  sent: number;
  delivered: number;
  read: number;
  followUpsSent: number;
}

@Injectable()
export class VerificationsService {
  private readonly logger = new Logger(VerificationsService.name);

  constructor(
    private readonly verificationsRepo: VerificationsRepository,
    private readonly billingEntitlements: BillingEntitlementService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly ordersRepo: OrdersRepository,
    private readonly commerceOutcomes: CommerceOutcomeRegistryService,
  ) {}

  async listByOrg(
    orgId: string,
    query: GetVerificationsQueryDto,
  ): Promise<PaginatedResponse<VerificationListItemDto>> {
    const statuses = this.parseStatuses(query.status);
    const dateRange = query.date_range ?? DEFAULT_STATS_DATE_RANGE;
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);

    // The reporting timezone has to be known before the date range can be
    // resolved, so this read is not part of the parallel batch below.
    const integrations = await this.integrationsRepo.findByOrg(orgId);
    const reportingTimezone = this.resolveReportingTimezone(integrations);
    const filterPeriod = resolveDashboardDateRangeBounds(
      dateRange,
      reportingTimezone,
    );

    const [verifications, totalCount] = await Promise.all([
      this.verificationsRepo.findByOrg(orgId, statuses, filterPeriod, {
        cursor,
        limit: limit + 1,
      }),
      this.verificationsRepo.countByOrg(orgId, statuses, filterPeriod),
    ]);
    const activeIntegrations = integrations.filter(
      (integration) => integration.isActive === true,
    );

    const hasMore = verifications.length > limit;
    const items = hasMore ? verifications.slice(0, limit) : verifications;

    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(items[items.length - 1])
        : null;

    return {
      data: items.map((verification) => ({
        capabilities: this.resolveRowCapabilities(
          verification,
          orgId,
          activeIntegrations,
        ),
        cancellation_operation: this.readCancellationOperation(
          verification.metadata,
        ),
        id: verification.id,
        status: verification.status,
        reason: readVerificationReason(verification.metadata),
        order_id: verification.orderId,
        order_number: verification.order?.orderNumber ?? null,
        is_test: isSyntheticOrder(verification.order),
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
      total_count: totalCount,
      page_context: {
        source: this.resolveDashboardSourceState(integrations),
        reporting_timezone: reportingTimezone,
        automation: this.resolveDashboardAutomationSettings(activeIntegrations),
      },
    };
  }

  /**
   * Row actions the merchant may take, reported as capabilities rather than
   * inferred by the client from the status.
   *
   * Both dashboard skins render their action set straight from this list, so
   * an action can never be offered in one runtime mode and missing in the
   * other, and a new platform opts in by supporting the outcome rather than by
   * a UI change.
   */
  private resolveRowCapabilities(
    verification: {
      status: VerificationStatus | null;
      metadata: unknown;
      order?: {
        orgId?: string;
        integrationId?: string | null;
        isTest?: boolean | null;
        externalOrderId?: string | null;
      } | null;
    },
    orgId: string,
    activeIntegrations: IntegrationRecord[],
  ): VerificationRowCapability[] {
    const ownedByOrg =
      !isSyntheticOrder(verification.order) &&
      verification.order?.orgId === orgId;
    const integration = activeIntegrations.find(
      (candidate) =>
        candidate.id === verification.order?.integrationId &&
        candidate.orgId === orgId &&
        candidate.isActive === true,
    );

    return [
      {
        action: 'merchant_no_reply_cancellation',
        supported:
          ownedByOrg &&
          integration !== undefined &&
          this.commerceOutcomes.supports(
            integration.platformType,
            'merchant_no_reply_cancellation',
          ),
      },
      {
        action: 'retry_verification',
        supported:
          ownedByOrg &&
          integration !== undefined &&
          canRetryVerification(
            verification.status,
            readVerificationReason(verification.metadata),
          ),
      },
    ];
  }

  private resolveReportingTimezone(integrations: IntegrationRecord[]): string {
    const source =
      integrations.find((integration) => integration.isActive === true) ??
      integrations[0];
    return resolveDashboardTimezone(
      source?.timezone ?? DEFAULT_REPORTING_TIMEZONE,
    );
  }

  async getStatsByOrg(
    orgId: string,
    query: GetVerificationStatsQueryDto,
  ): Promise<VerificationStatsDto> {
    const dateRange = query.date_range ?? DEFAULT_STATS_DATE_RANGE;

    const integrations = await this.integrationsRepo.findByOrg(orgId);
    const reportingTimezone = this.resolveReportingTimezone(integrations);
    const filterPeriod = resolveDashboardDateRangeBounds(
      dateRange,
      reportingTimezone,
    );

    const filteredCounts =
      await this.verificationsRepo.getFunnelCountsByOrgAndPeriod(
        orgId,
        filterPeriod.startAt,
        filterPeriod.endAt,
      );
    const activeIntegrations = integrations.filter(
      (integration) => integration.isActive === true,
    );

    if (activeIntegrations.length > 1)
      throw new ConflictException(
        'Multiple active commerce sources require staff review',
      );
    const usage = activeIntegrations[0]
      ? await this.billingEntitlements.readEntitlement(activeIntegrations[0])
      : {
          consumedCount: 0,
          includedLimit: 0,
          periodStart: null,
          periodEnd: null,
        };
    const replyRate = this.calculateReplyRate(filteredCounts);
    const confirmationRate = this.calculateConfirmationRate(filteredCounts);
    const usageLimit = usage.includedLimit;
    const shippingSettings =
      this.resolveDashboardShippingSettings(activeIntegrations);
    const automationSettings =
      this.resolveDashboardAutomationSettings(activeIntegrations);
    const moneySaved = Number(
      (filteredCounts.canceled * shippingSettings.avgShippingCost).toFixed(2),
    );

    return {
      date_range: dateRange,
      reporting_timezone: reportingTimezone,
      source: this.resolveDashboardSourceState(integrations),
      automation: automationSettings,
      totals: {
        total: filteredCounts.total,
        in_progress: filteredCounts.inProgress,
        needs_attention: filteredCounts.needsAttention,
        pending: filteredCounts.pending,
        failed: filteredCounts.failed,
        awaiting_reply: filteredCounts.awaitingReply,
        confirmed: filteredCounts.confirmed,
        canceled: filteredCounts.canceled,
        customer_canceled: filteredCounts.customerCanceled,
        sent: filteredCounts.sent,
        delivered: filteredCounts.delivered,
        read: filteredCounts.read,
        follow_ups_sent: filteredCounts.followUpsSent,
        reply_rate: replyRate,
        confirmation_rate: confirmationRate,
      },
      usage: {
        used: usage.consumedCount,
        limit: usageLimit,
        period_start: usage.periodStart ?? null,
        period_end: usage.periodEnd ?? null,
      },
      savings: {
        avg_shipping_cost: shippingSettings.avgShippingCost,
        currency: shippingSettings.currency,
        money_saved: moneySaved,
      },
    };
  }

  async cancelNoReplyOrder(
    user: AuthenticatedUser,
    verificationId: string,
  ): Promise<CancelOrderResponse> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to cancel an order.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    const orgId = user.orgId;
    const verification = await this.verificationsRepo.findByIdForOrg(
      verificationId,
      orgId,
    );
    if (!verification || verification.orgId !== orgId) {
      throw new NotFoundException('Verification not found');
    }
    if (
      verification.status === 'canceled' &&
      verification.cancellationSource === 'merchant_no_reply' &&
      verification.merchantCanceledAt
    ) {
      return this.cancellationResponse(
        verificationId,
        this.readCancellationOperation(verification.metadata),
        true,
      );
    }
    if (verification.status !== 'no_reply') {
      throw new BadRequestException(
        `Cannot cancel verification with status '${verification.status}'; only 'no_reply' verifications can be canceled`,
      );
    }
    const order = await this.ordersRepo.findById(verification.orderId);
    if (!order) throw new BadRequestException('Cannot cancel: order not found');
    if (!order.integration || !order.integrationId) {
      throw new BadRequestException(
        'Cannot cancel: order has no linked integration',
      );
    }
    if (
      order.orgId !== orgId ||
      order.integration.orgId !== orgId ||
      order.integration.id !== order.integrationId
    ) {
      throw new BadRequestException('Cannot cancel: source identity mismatch');
    }
    if (!order.externalOrderId)
      throw new BadRequestException(
        'Cannot cancel: order has no external order ID',
      );
    const command = {
      orgId,
      integrationId: order.integrationId,
      externalOrderId: order.externalOrderId,
      correlationId: verificationId,
    };
    const result = await this.commerceOutcomes.dispatch({
      ...command,
      action: 'merchant_no_reply_cancellation',
    });
    if (result.status === 'unsupported') {
      throw new BadRequestException({
        message: 'Order cancellation is not supported by this source',
        code: result.reason,
        operation: { status: result.status, reason: result.reason },
      });
    }
    if (result.status === 'permanent_failure') {
      throw new BadRequestException({
        message: 'Order cancellation could not be dispatched',
        code: result.errorCode,
        operation: { status: result.status, errorCode: result.errorCode },
      });
    }
    if (result.status === 'retryable_failure') {
      throw new BadGatewayException({
        message: 'Order cancellation failed',
        code: result.errorCode,
        operation: { status: result.status, errorCode: result.errorCode },
      });
    }
    const operation: CommerceOutcomeOperationResult =
      result.status === 'pending_provider_operation'
        ? {
            status: result.status,
            providerOperationId: result.providerOperationId,
          }
        : { status: result.status };
    const updated = await this.verificationsRepo.markMerchantNoReplyCanceled(
      verificationId,
      orgId,
      new Date().toISOString(),
      operation,
    );
    if (!updated) {
      const reloaded = await this.verificationsRepo.findByIdForOrg(
        verificationId,
        orgId,
      );
      if (
        reloaded?.status === 'canceled' &&
        reloaded.cancellationSource === 'merchant_no_reply'
      ) {
        return this.cancellationResponse(
          verificationId,
          this.readCancellationOperation(reloaded.metadata) ?? operation,
          true,
        );
      }
      this.logger.warn(
        buildBackendLog(VerificationsService.name, {
          action: 'verification-no-reply-cancel-mark-local',
          outcome: 'retry',
          orgId,
          verificationId,
          reason: 'status_changed_during_cancellation',
          providerOperationId:
            result.status === 'pending_provider_operation'
              ? result.providerOperationId
              : undefined,
        }),
      );
      throw new BadRequestException({
        message:
          'Verification status changed during cancellation; the provider accepted the request. Check order status before retrying.',
        operation,
      });
    }
    try {
      await this.commerceOutcomes.dispatch({
        ...command,
        action: 'merchant_cancellation_tagging',
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog(VerificationsService.name, {
          action: 'verification-no-reply-cancel-tag-order',
          outcome: 'retry',
          orgId,
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
    return this.cancellationResponse(verificationId, operation);
  }

  private cancellationResponse(
    verificationId: string,
    operation?: CommerceOutcomeOperationResult,
    alreadyCanceled?: boolean,
  ): CancelOrderResponse {
    return {
      success: true,
      verificationId,
      status: 'canceled',
      ...(alreadyCanceled ? { alreadyCanceled } : {}),
      ...(operation ? { operation } : {}),
      ...(operation?.status === 'pending_provider_operation'
        ? { providerOperationId: operation.providerOperationId }
        : {}),
    };
  }

  private readCancellationOperation(
    metadata: unknown,
  ): CommerceOutcomeOperationResult | undefined {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('commerceCancellation' in metadata)
    )
      return undefined;
    const operation = metadata.commerceCancellation;
    if (!operation || typeof operation !== 'object' || !('status' in operation))
      return undefined;
    if (operation.status === 'applied') return { status: 'applied' };
    if (operation.status === 'accepted_without_reference')
      return { status: operation.status };
    if (
      operation.status === 'pending_provider_operation' &&
      'providerOperationId' in operation &&
      typeof operation.providerOperationId === 'string'
    ) {
      return {
        status: operation.status,
        providerOperationId: operation.providerOperationId,
      };
    }
    return undefined;
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
   * Reply rate = (confirmed + customer-canceled) / sent.
   * Merchant no-reply cancellations are excluded from the numerator.
   */
  private calculateReplyRate(counts: VerificationStatusCounts): number {
    return this.percentageOfSent(
      counts.confirmed + counts.customerCanceled,
      counts.sent,
    );
  }

  private calculateConfirmationRate(counts: VerificationStatusCounts): number {
    return this.percentageOfSent(counts.confirmed, counts.sent);
  }

  /**
   * Expresses an outcome count as a share of the messages that were sent.
   *
   * The numerator and the denominator are counted off different columns
   * (`confirmed_at`/`canceled_at` against `last_sent_at`), so a row carrying a
   * customer's reply but no recorded send drags the ratio above 100% — which
   * is how the dashboard came to advertise a 150% reply rate. Rows like that
   * are a data defect, not a real outcome, and the send path is fixed so they
   * cannot recur; but a percentage of sends is bounded by definition, so this
   * refuses to render an impossible number regardless of what the columns say.
   */
  private percentageOfSent(outcomeCount: number, sent: number): number {
    if (sent <= 0) {
      return 0;
    }

    return Number(Math.min((outcomeCount / sent) * 100, 100).toFixed(1));
  }

  /**
   * Derives the current 30-day billing period start from the earliest active
   * integration's activation date, matching Shopify's rolling 30-day cycle.
   * Falls back to the 1st of the current UTC calendar month when no
   * activation date is available.
   */
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
      is_auto_verify_enabled: withSettings?.isAutoVerifyEnabled ?? false,
      follow_up_enabled: withSettings?.followUpEnabled ?? false,
      quiet_hours_enabled:
        withSettings?.quietHoursEnabled ?? DEFAULT_QUIET_HOURS_ENABLED,
    };
  }

  private resolveDashboardSourceState(
    integrations: IntegrationRecord[],
  ): DashboardSourceState {
    const active = integrations.find(
      (integration) => integration.isActive === true,
    );
    const source = active ?? integrations[0];

    return {
      status: active ? 'connected' : source ? 'disconnected' : 'not_connected',
      integration_id: source?.id ?? null,
      platform_type: source?.platformType ?? null,
    };
  }
}
