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
  DashboardUsageBudgetDto,
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
import {
  MANUALLY_CONFIRMABLE_STATUSES,
  type HeldOrderListRow,
  type NeedsActionRow,
} from '../../infrastructure/database/repositories/verifications.repository';
import type { NeedsActionContext } from '../../infrastructure/database/repositories/verification-needs-action.sql';
import {
  DEFAULT_ESCALATION_DELAY_MINUTES,
  NEEDS_ACTION_TOP_LIMIT,
} from '../../shared/verification/verification-needs-action';
import {
  buildMessageFunnel,
  rateOfSent,
  resolveUsage,
} from '../../shared/verification/verification-metrics';
import { VerificationHubService } from '../verification-core/verification-hub.service';
import type {
  GetVerificationOverviewQueryDto,
  NeedsActionItemDto,
  VerificationOverviewDto,
} from '../orders/dto/dashboard.dto';

/** What POST /api/verifications/:id/confirm answers. */
export interface ManualConfirmationResponse {
  success: true;
  verificationId: string;
  status: 'confirmed';
  alreadyConfirmed?: boolean;
}

const DEFAULT_FOLLOW_UP_DELAY_MINUTES = 120;
const MS_PER_HOUR = 3_600_000;

/** Digits of a search term, or undefined when nothing searchable remains. */
function toSearchDigits(term: string | undefined): string | undefined {
  const digits = term?.replace(/\D/g, '') ?? '';
  return digits.length > 0 ? digits : undefined;
}

function readProviderErrorCode(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const code = (metadata as Record<string, unknown>).providerErrorCode;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function readConfirmationSource(
  value: string | null | undefined,
): 'customer' | 'merchant_manual' | null {
  return value === 'customer' || value === 'merchant_manual' ? value : null;
}

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

/**
 * What the list filter accepts: the nine stored statuses plus the derived
 * hold value. 'awaiting_start' is not a `verification_status`; it describes
 * an order that has no verification yet, so it is answered from held orders
 * rather than from the enum.
 */
type ListStatusFilter = VerificationStatus | 'awaiting_start';

const ALLOWED_LIST_STATUSES: ListStatusFilter[] = [
  ...ALLOWED_STATUSES,
  'awaiting_start',
];

const DEFAULT_STATS_DATE_RANGE: DashboardDateRange = 'last_30_days';

/**
 * The lifecycle value a held order reads as, and the one extra value the
 * status filter accepts beyond the nine `verification_status` enum members.
 */
const HELD_STATUS = 'awaiting_start';

/** Narrows a merged row to the held projection `toHeldListRow` produced. */
function isHeldRow(row: unknown): row is { held: true } {
  return typeof row === 'object' && row !== null && 'held' in row;
}

/** Shapes a held order like the verification rows it is listed beside. */
function toHeldListRow(row: HeldOrderListRow) {
  return {
    // A held order has no verification, so the order id is the row identity.
    // It is also what `order_id` reports, which keeps the pair unambiguous.
    id: row.id,
    orderId: row.orderId,
    status: HELD_STATUS,
    metadata: null,
    createdAt: row.createdAt,
    lastSentAt: null,
    deliveredAt: null,
    readAt: null,
    confirmedAt: null,
    canceledAt: null,
    expiredAt: null,
    noReplyAt: null,
    followUpAttempts: 0,
    followUpSentAt: null,
    held: true as const,
    order: {
      orgId: row.orgId,
      integrationId: row.integrationId,
      externalOrderId: row.externalOrderId,
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      totalPrice: row.totalPrice,
      currency: row.currency,
      isTest: row.isTest,
    },
  };
}

/**
 * Merge two newest-first streams into one, keeping (created_at, id) order.
 *
 * Both sides are already sorted and already cursor-filtered, so taking the
 * larger head repeatedly gives the same page a single UNION would, without
 * touching the query the rest of E04 is built on.
 */
function mergeByRecency<
  A extends { createdAt: string | null; id: string },
  B extends { createdAt: string | null; id: string },
>(left: A[], right: B[], limit: number): Array<A | B> {
  const merged: Array<A | B> = [];
  let a = 0;
  let b = 0;
  while (merged.length < limit && (a < left.length || b < right.length)) {
    if (a >= left.length) merged.push(right[b++]);
    else if (b >= right.length) merged.push(left[a++]);
    else merged.push(isNewer(left[a], right[b]) ? left[a++] : right[b++]);
  }
  return merged;
}

function isNewer(
  left: { createdAt: string | null; id: string },
  right: { createdAt: string | null; id: string },
): boolean {
  const l = left.createdAt ?? '';
  const r = right.createdAt ?? '';
  if (l !== r) return l > r;
  return left.id > right.id;
}

/**
 * Rows a listing request answers with when the client does not say.
 *
 * Sized for a table that pages with Load-more rather than page numbers: a
 * screenful, not a scrollful. Every row carries its joined order, so this
 * default is what most requests actually cost.
 */
const DEFAULT_VERIFICATIONS_PAGE_SIZE = 20;
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
    private readonly verificationHub: VerificationHubService,
  ) {}

  async listByOrg(
    orgId: string,
    query: GetVerificationsQueryDto,
  ): Promise<PaginatedResponse<VerificationListItemDto>> {
    const statuses = this.parseStatuses(query.status);
    const dateRange = query.date_range ?? DEFAULT_STATS_DATE_RANGE;
    const limit = query.limit ?? DEFAULT_VERIFICATIONS_PAGE_SIZE;
    const cursor = decodeCursor(query.cursor);

    // The reporting timezone has to be known before the date range can be
    // resolved, so this read is not part of the parallel batch below.
    const integrations = await this.integrationsRepo.findByOrg(orgId);
    const reportingTimezone = this.resolveReportingTimezone(integrations);
    const activeIntegrations = integrations.filter(
      (integration) => integration.isActive === true,
    );
    const filterPeriod = resolveDashboardDateRangeBounds(
      dateRange,
      reportingTimezone,
    );

    // Held orders live outside `verifications` -- an import creates none --
    // so the page is two sorted streams merged on (created_at, id) rather
    // than one query. Either side is skipped when the status filter excludes
    // it, so the common case still costs exactly what it did before.
    const verificationStatuses = statuses?.filter(
      (status): status is VerificationStatus => status !== HELD_STATUS,
    );
    const tab = query.tab && query.tab !== 'all' ? query.tab : undefined;
    const searchDigits = toSearchDigits(query.q);
    const wantsVerifications =
      !verificationStatuses || verificationStatuses.length > 0;
    // A held order has no verification, so it belongs to no outcome tab, and
    // it has not been messaged, so a search for "who did we message" skips it.
    const wantsHeld =
      (!statuses || statuses.includes(HELD_STATUS)) && !tab && !searchDigits;
    const importBatchId = query.importBatchId;
    const needsAction = this.resolveNeedsActionContext(activeIntegrations);
    const refinement = { tab, searchDigits, needsAction };

    const [verifications, totalCount, heldRows, heldCount, usage, tabCounts] =
      await Promise.all([
        wantsVerifications
          ? this.verificationsRepo.findByOrg(
              orgId,
              verificationStatuses,
              filterPeriod,
              {
                cursor,
                limit: limit + 1,
                importBatchId,
                ...refinement,
              },
            )
          : [],
        wantsVerifications
          ? this.verificationsRepo.countByOrg(
              orgId,
              verificationStatuses,
              filterPeriod,
              importBatchId,
              refinement,
            )
          : 0,
        wantsHeld
          ? this.verificationsRepo.findHeldByOrg(orgId, filterPeriod, {
              cursor,
              limit: limit + 1,
              importBatchId,
            })
          : [],
        this.verificationsRepo.countHeldByOrg(
          orgId,
          filterPeriod,
          importBatchId,
        ),
        this.resolvePageUsage(activeIntegrations),
        this.verificationsRepo.countByTab(
          orgId,
          filterPeriod,
          needsAction,
          importBatchId,
        ),
      ]);

    const merged = mergeByRecency(
      verifications,
      heldRows.map(toHeldListRow),
      limit + 1,
    );
    const hasMore = merged.length > limit;
    const items = hasMore ? merged.slice(0, limit) : merged;

    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(items[items.length - 1])
        : null;

    return {
      data: items.map((verification) => ({
        // A held order offers nothing to cancel or retry: nothing has been
        // sent, and only POST /start may move it. The single-order read
        // already reports it non-retryable, so the list agrees with it.
        capabilities: isHeldRow(verification)
          ? []
          : this.resolveRowCapabilities(
              verification,
              orgId,
              activeIntegrations,
            ),
        cancellation_operation: this.readCancellationOperation(
          verification.metadata,
        ),
        id: verification.id,
        status: verification.status as VerificationStatus,
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
        external_order_id: verification.order?.externalOrderId ?? null,
        platform: this.resolvePlatform(
          verification.order?.integrationId,
          integrations,
        ),
        action_reason: isHeldRow(verification)
          ? null
          : (verification.actionReason ?? null),
        failure_code: readProviderErrorCode(verification.metadata),
        confirmation_source: isHeldRow(verification)
          ? null
          : readConfirmationSource(verification.confirmationSource),
        cancellation_source: isHeldRow(verification)
          ? null
          : (verification.cancellationSource ?? null),
        canceled_in_store:
          verification.status === 'canceled' &&
          this.readCancellationOperation(verification.metadata) !== undefined,
        updated_at: isHeldRow(verification)
          ? verification.createdAt
          : (verification.updatedAt ?? verification.createdAt ?? null),
        scheduled_for: resolveScheduledFor(verification),
      })),
      next_cursor: nextCursor,
      total_count: totalCount + (wantsHeld ? heldCount : 0),
      page_context: {
        source: this.resolveDashboardSourceState(integrations),
        reporting_timezone: reportingTimezone,
        automation: this.resolveDashboardAutomationSettings(activeIntegrations),
        usage,
        tab_counts: {
          ...tabCounts,
          all: tabCounts.all + heldCount,
        },
      },
    };
  }

  /**
   * Everything the embedded dashboard shows, in one request.
   *
   * Counts and sums are computed in SQL over the period's real orders; this
   * only composes them. The needs-action rule is the same SQL expression the
   * confirmations list filters on, so the card and the tab always agree.
   */
  async getOverview(
    orgId: string,
    query: GetVerificationOverviewQueryDto,
  ): Promise<VerificationOverviewDto> {
    const dateRange = query.date_range ?? DEFAULT_STATS_DATE_RANGE;
    const integrations = await this.integrationsRepo.findByOrg(orgId);
    const activeIntegrations = integrations.filter(
      (integration) => integration.isActive === true,
    );
    if (activeIntegrations.length > 1)
      throw new ConflictException(
        'Multiple active commerce sources require staff review',
      );
    const reportingTimezone = this.resolveReportingTimezone(integrations);
    const period = resolveDashboardDateRangeBounds(
      dateRange,
      reportingTimezone,
    );
    const needsAction = this.resolveNeedsActionContext(activeIntegrations);
    const source = activeIntegrations[0];

    const [counts, confirmedValue, topRows, entitlement] = await Promise.all([
      this.verificationsRepo.getOverviewCounts(orgId, period, needsAction),
      this.verificationsRepo.getConfirmedValueByCurrency(orgId, period),
      this.verificationsRepo.findNeedsActionTop(
        orgId,
        period,
        needsAction,
        NEEDS_ACTION_TOP_LIMIT,
      ),
      source ? this.billingEntitlements.readEntitlement(source) : null,
    ]);

    return {
      date_range: dateRange,
      reporting_timezone: reportingTimezone,
      source: this.resolveDashboardSourceState(integrations),
      settings: {
        auto_verify_enabled: source?.isAutoVerifyEnabled ?? false,
        follow_up_enabled: source?.followUpEnabled ?? false,
        follow_up_delay_minutes:
          source?.followUpDelayMinutes ?? DEFAULT_FOLLOW_UP_DELAY_MINUTES,
        quiet_hours_enabled:
          source?.quietHoursEnabled ?? DEFAULT_QUIET_HOURS_ENABLED,
        quiet_hours_start: source?.quietHoursStart ?? null,
        quiet_hours_end: source?.quietHoursEnd ?? null,
      },
      usage: entitlement
        ? resolveUsage(entitlement.consumedCount, entitlement.includedLimit)
        : null,
      kpis: {
        confirmed: { count: counts.confirmed, value: confirmedValue },
        canceled_before_shipping: { count: counts.customerCanceled },
        confirmation_rate: {
          rate: rateOfSent(counts.confirmedAfterSend, counts.sent),
          confirmed: Math.min(counts.confirmedAfterSend, counts.sent),
          sent: counts.sent,
        },
      },
      funnel: buildMessageFunnel(counts),
      needs_action: {
        count: counts.needsAction,
        items: topRows.map((row) =>
          this.toNeedsActionItem(
            row,
            orgId,
            activeIntegrations,
            integrations,
            needsAction.now,
          ),
        ),
      },
    };
  }

  /**
   * The merchant confirms an order by hand (they called the customer, say).
   *
   * Lands on exactly the path a customer's "confirm" reply takes after the
   * status write -- `finalizeVerification` -- so the store receives the same
   * tag. The row records that it was manual; pending follow-up and no-reply
   * jobs see a final status and do nothing.
   */
  async confirmManually(
    user: AuthenticatedUser,
    verificationId: string,
  ): Promise<ManualConfirmationResponse> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to confirm an order.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    const orgId = user.orgId;
    const verification = await this.verificationsRepo.findByIdForOrg(
      verificationId,
      orgId,
    );
    if (!verification || verification.orgId !== orgId) {
      throw new NotFoundException({
        message: 'Verification not found',
        code: 'VERIFICATION_NOT_FOUND',
      });
    }
    if (verification.status === 'confirmed') {
      return {
        success: true,
        verificationId,
        status: 'confirmed',
        alreadyConfirmed: true,
      };
    }
    if (!MANUALLY_CONFIRMABLE_STATUSES.includes(verification.status)) {
      throw new ConflictException({
        message: `A verification with status '${verification.status}' cannot be confirmed manually`,
        code: 'VERIFICATION_NOT_CONFIRMABLE',
      });
    }

    const updated = await this.verificationsRepo.markMerchantConfirmed(
      verificationId,
      orgId,
      user.userId,
    );
    if (!updated) {
      throw new ConflictException({
        message: 'The verification changed before it could be confirmed',
        code: 'VERIFICATION_NOT_CONFIRMABLE',
      });
    }

    this.logger.log(
      buildBackendLog(VerificationsService.name, {
        action: 'verification-manual-confirm',
        outcome: 'success',
        orgId,
        verificationId,
      }),
    );
    await this.verificationHub.finalizeVerification(
      verificationId,
      'confirmed',
    );
    return { success: true, verificationId, status: 'confirmed' };
  }

  private toNeedsActionItem(
    row: NeedsActionRow,
    orgId: string,
    activeIntegrations: IntegrationRecord[],
    integrations: IntegrationRecord[],
    now: string,
  ): NeedsActionItemDto {
    const type = row.actionReason ?? 'no_reply';
    const since =
      type === 'read_no_reply'
        ? row.readAt
        : (row.lastSentAt ?? row.createdAt ?? null);
    const hours = since
      ? Math.max(
          Math.floor((Date.parse(now) - Date.parse(since)) / MS_PER_HOUR),
          0,
        )
      : null;
    return {
      verification_id: row.id,
      order_id: row.orderId,
      external_order_id: row.order.externalOrderId ?? null,
      platform: this.resolvePlatform(row.order.integrationId, integrations),
      order_number: row.order.orderNumber ?? null,
      customer_name: row.order.customerName ?? null,
      customer_phone: row.order.customerPhone ?? null,
      total_price: row.order.totalPrice ?? null,
      currency: row.order.currency ?? null,
      reason: {
        type,
        since,
        hours: Number.isFinite(hours) ? hours : null,
        failure_code:
          type === 'delivery_failed'
            ? readProviderErrorCode(row.metadata)
            : null,
      },
      capabilities: this.resolveRowCapabilities(row, orgId, activeIntegrations),
    };
  }

  private resolveNeedsActionContext(
    activeIntegrations: IntegrationRecord[],
  ): NeedsActionContext {
    return {
      now: new Date().toISOString(),
      escalationDelayMinutes:
        activeIntegrations[0]?.escalationDelayMinutes ??
        DEFAULT_ESCALATION_DELAY_MINUTES,
    };
  }

  private resolvePlatform(
    integrationId: string | null | undefined,
    integrations: IntegrationRecord[],
  ): string | null {
    if (!integrationId) return null;
    return (
      integrations.find((integration) => integration.id === integrationId)
        ?.platformType ?? null
    );
  }

  /**
   * Included-verification budget for the source this page is showing.
   *
   * Served on the listing rather than only on `/stats` so the client can decide
   * whether to offer order creation from the same response that already tells
   * it whether the merchant is allowed to create one -- previously the
   * permission was known and the budget was not, so the action stayed enabled
   * at the limit and failed only after the merchant had filled the form.
   *
   * Reports nothing when there is no single active source; that ambiguity is
   * already surfaced through `source`, and inventing a zero budget here would
   * read as "limit reached".
   */
  private async resolvePageUsage(
    activeIntegrations: (typeof integrations.$inferSelect)[],
  ): Promise<DashboardUsageBudgetDto | undefined> {
    const source =
      activeIntegrations.length === 1 ? activeIntegrations[0] : null;
    if (!source) return undefined;
    const entitlement = await this.billingEntitlements.readEntitlement(source);
    return {
      used: entitlement.consumedCount,
      limit: entitlement.includedLimit,
      remaining: Math.max(
        entitlement.includedLimit - entitlement.consumedCount,
        0,
      ),
      period_end:
        'credits' in entitlement ? null : (entitlement.periodEnd ?? null),
      ...('creditDenial' in entitlement
        ? { credit_denial: entitlement.creditDenial }
        : {}),
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
      {
        action: 'merchant_manual_confirmation',
        supported:
          ownedByOrg &&
          integration !== undefined &&
          verification.status !== null &&
          MANUALLY_CONFIRMABLE_STATUSES.includes(verification.status),
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
    const confirmedInPeriod = usage.periodStart
      ? await this.verificationsRepo.getConfirmedTotalsByOrgSince(
          orgId,
          usage.periodStart,
        )
      : { count: 0, value: '0' };
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
        confirmed_in_period: confirmedInPeriod.count,
        confirmed_value_in_period: confirmedInPeriod.value,
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

  private parseStatuses(input?: string): ListStatusFilter[] | undefined {
    if (!input) return undefined;

    const statuses = input
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean) as ListStatusFilter[];

    if (statuses.length === 0) return undefined;

    const invalid = statuses.filter(
      (status) => !ALLOWED_LIST_STATUSES.includes(status),
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

function resolveScheduledFor(verification: {
  status: string;
  lastSentAt?: string | null;
  nextRetryAt?: string | null;
}): string | null {
  if (verification.status !== 'pending' || verification.lastSentAt) return null;
  if (!verification.nextRetryAt) return null;
  return new Date(verification.nextRetryAt).getTime() > Date.now()
    ? verification.nextRetryAt
    : null;
}
