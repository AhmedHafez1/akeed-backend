import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { maskPhone } from '../../shared/utils/mask-phone.util';
import { readVerificationReason } from '../../shared/verification/verification-row-actions';
import {
  decodeCursor,
  encodeCursor,
} from '../orders/services/pagination.helpers';
import { resolveIncludedVerificationsLimit } from '../onboarding/onboarding.service.helpers';
import { AdminHealthRuleService } from './admin-health-rule.service';
import {
  AdminQueryRepository,
  type AdminStoreDetailQueryRow,
  type AdminStoreQueryRow,
  type AdminStoreVerificationRow,
} from './admin-query.repository';
import type {
  AdminStoreVerificationsQueryDto,
  AdminStoresQueryDto,
} from './dto/admin-query.dto';
import type { AdminHealthStatus, AdminLifecycleStatus } from './admin.types';
import { balanceState } from './standalone-billing-operations.policy';
import type { BalanceState } from './standalone-billing-operations.types';

type PlanId = 'starter' | 'basic' | 'pro' | 'business';

interface AdminUsage {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
}

export type AdminStoreBilling =
  | {
      model: 'plan';
      plan: PlanId | null;
      subscription_status: string | null;
      usage: AdminUsage;
    }
  | {
      model: 'credits';
      account_status: string;
      available: number;
      held: number;
      debt: number;
      balance_state: BalanceState;
    };

export interface AdminStoreView {
  integration_id: string;
  org_id: string;
  platform: string;
  organization_name: string;
  store_name: string;
  shop_domain: string | null;
  source_identity: string;
  country_code: string | null;
  timezone: string | null;
  installed_at: string;
  lifecycle_status: AdminLifecycleStatus;
  onboarding_status: string;
  plan: string | null;
  subscription_status: string | null;
  usage: AdminUsage;
  billing: AdminStoreBilling;
  auto_confirmation_enabled: boolean;
  test_message_status: 'not_requested' | 'requested' | 'delivered';
  first_eligible_real_order_at: string | null;
  activated_at: string | null;
  last_activity_at: string | null;
  health: {
    status: AdminHealthStatus;
    top_signal: string | null;
    signal_count: number;
    signals: string[];
  };
  data_quality: string[];
}

export interface AdminStoreMilestone {
  key: string;
  at: string | null;
  estimated: boolean;
}

export interface AdminStoreDetailView extends AdminStoreView {
  owner_email: string | null;
  created_at: string | null;
  last_synced_at: string | null;
  billing_activated_at: string | null;
  settings: {
    default_language: string;
    shipping_currency: string;
    follow_up_enabled: boolean;
    follow_up_delay_minutes: number;
    escalation_enabled: boolean;
    quiet_hours_enabled: boolean;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    send_delay_minutes: number;
  };
  milestones: AdminStoreMilestone[];
  verification_totals: {
    total: number;
    test: number;
    by_status: Record<string, number>;
    failed_24h: number;
    total_24h: number;
  };
}

export interface AdminStoreVerificationView {
  id: string;
  status: string;
  reason: string | null;
  order_number: string | null;
  external_order_id: string;
  is_test: boolean;
  customer_name: string | null;
  customer_phone_masked: string;
  total_price: string | null;
  currency: string | null;
  attempts: number;
  follow_up_attempts: number;
  template_name: string | null;
  language_code: string | null;
  cancellation_source: string | null;
  created_at: string;
  updated_at: string | null;
  last_sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  confirmed_at: string | null;
  canceled_at: string | null;
  expired_at: string | null;
  no_reply_at: string | null;
  follow_up_sent_at: string | null;
}

@Injectable()
export class AdminStoresService {
  constructor(
    private readonly repository: AdminQueryRepository,
    private readonly healthRules: AdminHealthRuleService,
    private readonly config: ConfigService,
  ) {}

  async getStores(query: AdminStoresQueryDto) {
    const rows = await this.repository.findStores();
    const lowBalanceThreshold = this.lowBalanceThreshold();
    const filtered = rows
      .map((row) => ({ row, store: this.toView(row, lowBalanceThreshold) }))
      .filter(({ row, store }) => this.matches(store, row, query))
      .map(({ store }) => store);
    const sorted = this.sort(filtered, query);
    const offset = this.cursorOffset(sorted, query.cursor);
    const limit = query.limit ?? 50;
    const data = sorted.slice(offset, offset + limit);
    const hasMore = offset + limit < sorted.length;

    return {
      summary: this.summary(filtered),
      data,
      next_cursor: hasMore
        ? Buffer.from(
            JSON.stringify({ id: data.at(-1)?.integration_id }),
          ).toString('base64url')
        : null,
      evaluated_at: new Date().toISOString(),
    };
  }

  async getAllViews(): Promise<AdminStoreView[]> {
    const lowBalanceThreshold = this.lowBalanceThreshold();
    return (await this.repository.findStores()).map((row) =>
      this.toView(row, lowBalanceThreshold),
    );
  }

  async getStore(integrationId: string) {
    const row = await this.requireStore(integrationId);
    const totals =
      await this.repository.findStoreVerificationTotals(integrationId);
    return {
      store: this.toDetailView(row, totals),
      evaluated_at: new Date().toISOString(),
    };
  }

  async getStoreVerifications(
    integrationId: string,
    query: AdminStoreVerificationsQueryDto,
  ) {
    await this.requireStore(integrationId);
    const limit = query.limit ?? 25;
    const { rows, totalCount } = await this.repository.findStoreVerifications(
      integrationId,
      {
        statuses: query.status,
        includeTest: query.include_test ?? false,
        cursor: decodeCursor(query.cursor),
        limit: limit + 1,
      },
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      data: page.map((verification) => this.toVerificationView(verification)),
      next_cursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.created_at, id: last.id })
          : null,
      total_count: totalCount,
    };
  }

  private async requireStore(
    integrationId: string,
  ): Promise<AdminStoreDetailQueryRow> {
    const row = await this.repository.findStoreById(integrationId);
    if (!row) throw new NotFoundException('Store not found.');
    return row;
  }

  private toDetailView(
    row: AdminStoreDetailQueryRow,
    totals: Awaited<
      ReturnType<AdminQueryRepository['findStoreVerificationTotals']>
    >,
  ): AdminStoreDetailView {
    const view = this.toView(row, this.lowBalanceThreshold());
    const byStatus: Record<string, number> = {};
    let total = 0;
    let test = 0;
    for (const entry of totals) {
      const count = Number(entry.count ?? 0);
      if (entry.is_test) {
        test += count;
        continue;
      }
      total += count;
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + count;
    }
    const milestones = this.resolvedMilestones(row);

    return {
      ...view,
      owner_email: row.owner_email,
      created_at: row.created_at,
      last_synced_at: row.last_synced_at,
      billing_activated_at: row.billing_activated_at,
      settings: {
        default_language: row.default_language,
        shipping_currency: row.shipping_currency,
        follow_up_enabled: row.follow_up_enabled,
        follow_up_delay_minutes: row.follow_up_delay_minutes,
        escalation_enabled: row.escalation_enabled,
        quiet_hours_enabled: row.quiet_hours_enabled,
        quiet_hours_start: row.quiet_hours_start,
        quiet_hours_end: row.quiet_hours_end,
        send_delay_minutes: row.send_delay_minutes,
      },
      milestones: [
        {
          key: 'installation_completed',
          at: row.installed_at,
          estimated: !row.has_lifecycle && row.platform_type === 'shopify',
        },
        this.milestone(
          row,
          'onboarding_completed',
          row.onboarding_completed_at,
        ),
        this.milestone(row, 'plan_selected', row.plan_selected_at),
        this.milestone(row, 'test_requested', row.test_requested_at),
        this.milestone(row, 'test_delivered', row.test_delivered_at),
        {
          key: 'eligible_real_cod_detected',
          at: milestones.firstEligibleOrderAt,
          estimated:
            milestones.eligibleEstimated ||
            this.isEstimated(row, 'eligible_real_cod_detected'),
        },
        this.milestone(
          row,
          'first_confirmation_delivered',
          row.first_message_delivered_at,
        ),
        this.milestone(
          row,
          'first_customer_response',
          row.first_customer_response_at,
        ),
        {
          key: 'first_real_cod_resolved',
          at: milestones.firstResolvedAt,
          estimated:
            milestones.resolvedEstimated ||
            this.isEstimated(row, 'first_real_cod_resolved'),
        },
        this.milestone(
          row,
          'paid_subscription_activated',
          row.paid_subscription_activated_at,
        ),
        this.milestone(row, 'uninstalled', row.uninstalled_at),
      ],
      verification_totals: {
        total,
        test,
        by_status: byStatus,
        failed_24h: Number(row.failed_24h ?? 0),
        total_24h: Number(row.total_24h ?? 0),
      },
    };
  }

  private milestone(
    row: AdminStoreQueryRow,
    key: string,
    at: string | null,
  ): AdminStoreMilestone {
    return { key, at, estimated: at ? this.isEstimated(row, key) : false };
  }

  private isEstimated(row: AdminStoreQueryRow, key: string): boolean {
    return String(row.provenance?.[key] ?? '').startsWith('estimated');
  }

  private toVerificationView(
    row: AdminStoreVerificationRow,
  ): AdminStoreVerificationView {
    return {
      id: row.id,
      status: row.status,
      reason: readVerificationReason(row.metadata),
      order_number: row.order_number,
      external_order_id: row.external_order_id,
      is_test: row.is_test,
      customer_name: row.customer_name,
      customer_phone_masked: maskPhone(row.customer_phone),
      total_price: row.total_price,
      currency: row.currency,
      attempts: Number(row.attempts ?? 0),
      follow_up_attempts: Number(row.follow_up_attempts ?? 0),
      template_name: row.template_name,
      language_code: row.language_code,
      cancellation_source: row.cancellation_source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_sent_at: row.last_sent_at,
      delivered_at: row.delivered_at,
      read_at: row.read_at,
      confirmed_at: row.confirmed_at,
      canceled_at: row.canceled_at,
      expired_at: row.expired_at,
      no_reply_at: row.no_reply_at,
      follow_up_sent_at: row.follow_up_sent_at,
    };
  }

  private lowBalanceThreshold(): number {
    return readStandaloneCreditBillingConfig(this.config).lowBalanceThreshold;
  }

  private resolvedMilestones(row: AdminStoreQueryRow) {
    const derive = !row.has_lifecycle && row.platform_type !== 'shopify';
    const eligibleEstimated =
      derive &&
      !row.first_eligible_order_at &&
      Boolean(row.derived_first_eligible_order_at);
    const resolvedEstimated =
      derive &&
      !row.first_resolved_at &&
      Boolean(row.derived_first_resolved_at);
    return {
      firstEligibleOrderAt: eligibleEstimated
        ? row.derived_first_eligible_order_at
        : row.first_eligible_order_at,
      firstResolvedAt: resolvedEstimated
        ? row.derived_first_resolved_at
        : row.first_resolved_at,
      eligibleEstimated,
      resolvedEstimated,
    };
  }

  private billing(
    row: AdminStoreQueryRow,
    plan: PlanId | null,
    usage: AdminUsage,
    lowBalanceThreshold: number,
  ): AdminStoreBilling {
    if (row.platform_type === 'standalone' && row.credit_account_status) {
      const postedBalance = Number(row.credit_posted_balance ?? 0);
      const heldCredits = Number(row.credit_held_credits ?? 0);
      return {
        model: 'credits',
        account_status: row.credit_account_status,
        available: Math.max(postedBalance - heldCredits, 0),
        held: heldCredits,
        debt: postedBalance < 0 ? -postedBalance : 0,
        balance_state: balanceState(
          {
            status: row.credit_account_status,
            postedBalance,
            heldCredits,
          },
          lowBalanceThreshold,
        ),
      };
    }
    return {
      model: 'plan',
      plan,
      subscription_status: row.subscription_status,
      usage,
    };
  }

  private toView(
    row: AdminStoreQueryRow,
    lowBalanceThreshold: number,
  ): AdminStoreView {
    const plan = row.plan as PlanId | null;
    const used = Number(row.usage_used ?? 0);
    const explicitLimit = Number(row.usage_limit ?? 0);
    const limit =
      explicitLimit || (plan ? resolveIncludedVerificationsLimit(plan) : 0);
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const usage = {
      used,
      limit,
      remaining: Math.max(limit - used, 0),
      percent,
    };
    const billing = this.billing(row, plan, usage, lowBalanceThreshold);
    const credits = billing.model === 'credits';
    const milestones = this.resolvedMilestones(row);
    const lifecycle = this.lifecycle(row, milestones.firstResolvedAt);
    const health = this.healthRules.evaluate({
      onboardingStatus: row.onboarding_status,
      installedAt: row.installed_at,
      onboardingCompletedAt: row.onboarding_completed_at,
      firstEligibleOrderAt: milestones.firstEligibleOrderAt,
      firstResolvedAt: milestones.firstResolvedAt,
      uninstalledAt: row.uninstalled_at,
      usagePercent: credits ? 0 : percent,
      failed24h: Number(row.failed_24h ?? 0),
      total24h: Number(row.total_24h ?? 0),
      failedWebhooks1h: Number(row.failed_webhooks_1h ?? 0),
      autoEnabled: row.auto_confirmation_enabled,
      billingStatus: credits ? null : row.subscription_status,
      lastActivityAt: row.last_activity_at,
      creditBalanceState: credits ? billing.balance_state : null,
    });
    const provenance = row.provenance ?? {};
    const dataQuality =
      Object.values(provenance).some((value) =>
        String(value).startsWith('estimated'),
      ) ||
      milestones.eligibleEstimated ||
      milestones.resolvedEstimated
        ? ['estimated_historical_data']
        : [];

    return {
      integration_id: row.integration_id,
      org_id: row.org_id,
      platform: row.platform_type,
      organization_name: row.organization_name,
      store_name: row.store_name ?? row.organization_name,
      shop_domain: row.platform_type === 'standalone' ? null : row.shop_domain,
      source_identity: row.shop_domain,
      country_code: row.country_code,
      timezone: row.timezone,
      installed_at: row.installed_at,
      lifecycle_status: lifecycle,
      onboarding_status: row.onboarding_status,
      plan,
      subscription_status: row.subscription_status,
      usage,
      billing,
      auto_confirmation_enabled: row.auto_confirmation_enabled,
      test_message_status: row.test_delivered_at
        ? 'delivered'
        : row.test_requested_at
          ? 'requested'
          : 'not_requested',
      first_eligible_real_order_at: milestones.firstEligibleOrderAt,
      activated_at: milestones.firstResolvedAt,
      last_activity_at: row.last_activity_at,
      health,
      data_quality: dataQuality,
    };
  }

  private lifecycle(
    row: AdminStoreQueryRow,
    firstResolvedAt: string | null,
  ): AdminLifecycleStatus {
    if (row.uninstalled_at) return 'uninstalled';
    if (!row.is_active) return 'inactive';
    if (row.onboarding_status !== 'completed') return 'onboarding';
    if (firstResolvedAt) return 'active';
    return 'installed';
  }

  private matches(
    store: AdminStoreView,
    raw: AdminStoreQueryRow,
    query: AdminStoresQueryDto,
  ): boolean {
    const search = query.search?.trim().toLocaleLowerCase();
    if (
      search &&
      ![store.store_name, store.shop_domain, raw.organization_name]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(search))
    ) {
      return false;
    }
    if (query.platform && store.platform !== query.platform) return false;
    if (query.plan && store.plan !== query.plan) return false;
    if (
      query.lifecycle_status &&
      store.lifecycle_status !== query.lifecycle_status
    )
      return false;
    if (
      query.onboarding_status &&
      store.onboarding_status !== query.onboarding_status
    )
      return false;
    if (query.health_status && store.health.status !== query.health_status)
      return false;
    if (
      query.country &&
      (store.country_code ?? '').toUpperCase() !== query.country.toUpperCase()
    )
      return false;
    if (
      !this.inRange(
        store.installed_at,
        query.installed_from,
        query.installed_to,
      )
    )
      return false;
    if (
      (query.last_activity_from || query.last_activity_to) &&
      (!store.last_activity_at ||
        !this.inRange(
          store.last_activity_at,
          query.last_activity_from,
          query.last_activity_to,
        ))
    )
      return false;
    return true;
  }

  private inRange(value: string, from?: string, to?: string): boolean {
    const timestamp = new Date(value).getTime();
    const toTimestamp = to
      ? new Date(to).getTime() +
        (/^\d{4}-\d{2}-\d{2}$/.test(to) ? 86_399_999 : 0)
      : null;
    return (
      (!from || timestamp >= new Date(from).getTime()) &&
      (toTimestamp === null || timestamp <= toTimestamp)
    );
  }

  private sort(stores: AdminStoreView[], query: AdminStoresQueryDto) {
    const key = query.sort ?? 'installed_at';
    const direction = query.direction ?? 'desc';
    const severity = { healthy: 0, attention_required: 1, critical: 2 };
    const value = (store: AdminStoreView): string | number => {
      switch (key) {
        case 'store_name':
          return store.store_name.toLocaleLowerCase();
        case 'last_activity':
          return store.last_activity_at ?? '';
        case 'usage_percent':
          return store.usage.percent;
        case 'activation_date':
          return store.activated_at ?? '';
        case 'health':
          return severity[store.health.status];
        default:
          return store.installed_at;
      }
    };
    return [...stores].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      const compared =
        leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      const stable =
        compared || left.integration_id.localeCompare(right.integration_id);
      return direction === 'asc' ? stable : -stable;
    });
  }

  private cursorOffset(stores: AdminStoreView[], cursor?: string): number {
    if (!cursor) return 0;
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString(),
      ) as {
        id?: string;
      };
      const index = stores.findIndex(
        (store) => store.integration_id === parsed.id,
      );
      if (index < 0) throw new Error('Missing cursor row');
      return index + 1;
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }

  private summary(stores: AdminStoreView[]) {
    const count = (predicate: (store: AdminStoreView) => boolean) =>
      stores.filter(predicate).length;
    return {
      currently_installed: count(
        (store) => store.lifecycle_status !== 'uninstalled',
      ),
      onboarding: count((store) => store.lifecycle_status === 'onboarding'),
      activated: count((store) => store.lifecycle_status === 'active'),
      inactive: count((store) => store.lifecycle_status === 'inactive'),
      uninstalled: count((store) => store.lifecycle_status === 'uninstalled'),
      healthy: count((store) => store.health.status === 'healthy'),
      attention_required: count(
        (store) => store.health.status === 'attention_required',
      ),
      critical: count((store) => store.health.status === 'critical'),
    };
  }
}
