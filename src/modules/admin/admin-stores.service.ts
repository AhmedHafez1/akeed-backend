import { BadRequestException, Injectable } from '@nestjs/common';
import { resolveIncludedVerificationsLimit } from '../onboarding/onboarding.service.helpers';
import { AdminHealthRuleService } from './admin-health-rule.service';
import {
  AdminQueryRepository,
  type AdminStoreQueryRow,
} from './admin-query.repository';
import type { AdminStoresQueryDto } from './dto/admin-query.dto';
import type { AdminHealthStatus, AdminLifecycleStatus } from './admin.types';

export interface AdminStoreView {
  integration_id: string;
  store_name: string;
  shop_domain: string;
  country_code: string | null;
  timezone: string | null;
  installed_at: string;
  lifecycle_status: AdminLifecycleStatus;
  onboarding_status: string;
  plan: string | null;
  subscription_status: string | null;
  usage: { used: number; limit: number; remaining: number; percent: number };
  auto_confirmation_enabled: boolean;
  test_message_status: 'not_requested' | 'requested' | 'delivered';
  first_eligible_real_order_at: string | null;
  activated_at: string | null;
  last_activity_at: string | null;
  health: {
    status: AdminHealthStatus;
    top_signal: string | null;
    signal_count: number;
  };
  data_quality: string[];
}

@Injectable()
export class AdminStoresService {
  constructor(
    private readonly repository: AdminQueryRepository,
    private readonly healthRules: AdminHealthRuleService,
  ) {}

  async getStores(query: AdminStoresQueryDto) {
    const rows = await this.repository.findStores();
    const filtered = rows
      .map((row) => ({ row, store: this.toView(row) }))
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
    return (await this.repository.findStores()).map((row) => this.toView(row));
  }

  private toView(row: AdminStoreQueryRow): AdminStoreView {
    const plan = row.plan as 'starter' | 'basic' | 'pro' | 'business' | null;
    const used = Number(row.usage_used ?? 0);
    const explicitLimit = Number(row.usage_limit ?? 0);
    const limit =
      explicitLimit || (plan ? resolveIncludedVerificationsLimit(plan) : 0);
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const lifecycle = this.lifecycle(row);
    const health = this.healthRules.evaluate({
      onboardingStatus: row.onboarding_status,
      installedAt: row.installed_at,
      onboardingCompletedAt: row.onboarding_completed_at,
      firstEligibleOrderAt: row.first_eligible_order_at,
      firstResolvedAt: row.first_resolved_at,
      uninstalledAt: row.uninstalled_at,
      usagePercent: percent,
      failed24h: Number(row.failed_24h ?? 0),
      total24h: Number(row.total_24h ?? 0),
      failedWebhooks1h: Number(row.failed_webhooks_1h ?? 0),
      autoEnabled: row.auto_confirmation_enabled,
      billingStatus: row.subscription_status,
      lastActivityAt: row.last_activity_at,
    });
    const provenance = row.provenance ?? {};
    const dataQuality = Object.values(provenance).some((value) =>
      String(value).startsWith('estimated'),
    )
      ? ['estimated_historical_data']
      : [];

    return {
      integration_id: row.integration_id,
      store_name: row.store_name ?? row.organization_name,
      shop_domain: row.shop_domain,
      country_code: row.country_code,
      timezone: row.timezone,
      installed_at: row.installed_at,
      lifecycle_status: lifecycle,
      onboarding_status: row.onboarding_status,
      plan,
      subscription_status: row.subscription_status,
      usage: {
        used,
        limit,
        remaining: Math.max(limit - used, 0),
        percent,
      },
      auto_confirmation_enabled: row.auto_confirmation_enabled,
      test_message_status: row.test_delivered_at
        ? 'delivered'
        : row.test_requested_at
          ? 'requested'
          : 'not_requested',
      first_eligible_real_order_at: row.first_eligible_order_at,
      activated_at: row.first_resolved_at,
      last_activity_at: row.last_activity_at,
      health,
      data_quality: dataQuality,
    };
  }

  private lifecycle(row: AdminStoreQueryRow): AdminLifecycleStatus {
    if (row.uninstalled_at) return 'uninstalled';
    if (!row.is_active) return 'inactive';
    if (row.onboarding_status !== 'completed') return 'onboarding';
    if (row.first_resolved_at) return 'active';
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
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase().includes(search))
    ) {
      return false;
    }
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
