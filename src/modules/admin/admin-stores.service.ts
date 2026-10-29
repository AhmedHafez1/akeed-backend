import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { ReviewPromptsRepository } from '../../infrastructure/database/repositories/review-prompts.repository';
import { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import {
  effectiveReviewPromptState,
  reviewPromptVariantFor,
} from '../../shared/review-prompt/review-prompt.policy';
import type { ImageTwinTemplate } from '../../shared/messaging/template-registry.types';
import { ConfigService } from '@nestjs/config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { maskPhone } from '../../shared/utils/mask-phone.util';
import {
  readProviderErrorCode,
  readProviderErrorTitle,
  readVerificationReason,
} from '../../shared/verification/verification-row-actions';
import {
  decodeCursor,
  encodeCursor,
} from '../orders/services/pagination.helpers';
import { resolveIncludedVerificationsLimit } from '../onboarding/onboarding.service.helpers';
import { AdminHealthRuleService } from './admin-health-rule.service';
import {
  AdminQueryRepository,
  type AdminStoreDerivation,
  type AdminStoreDetailQueryRow,
  type AdminStoreQueryRow,
  type AdminStoreSortKey,
  type AdminStoreVerificationRow,
  type AdminStoreViewRow,
} from './admin-query.repository';
import type {
  AdminStoreVerificationsQueryDto,
  AdminStoresQueryDto,
} from './dto/admin-query.dto';
import type { AdminHealthStatus, AdminLifecycleStatus } from './admin.types';
import type { BalanceState } from './standalone-billing-operations.types';

const PLAN_IDS = ['starter', 'basic', 'pro', 'business'] as const;

export const REVIEW_PROMPT_ADMIN_ERROR_CODES = {
  optedOut: 'REVIEW_PROMPT_OPTED_OUT',
  unsupportedStore: 'REVIEW_PROMPT_UNSUPPORTED_STORE',
} as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PlanId = (typeof PLAN_IDS)[number];

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

export interface AdminCustomerCountries {
  /** The most common country, or null before any order has one. */
  top: string | null;
  /** Its share (0-100) of the orders whose country is known. */
  share: number | null;
  /** How many countries the orders come from. */
  count: number;
}

export interface AdminStoreView {
  integration_id: string;
  org_id: string;
  platform: string;
  organization_name: string;
  store_name: string;
  shop_domain: string | null;
  source_identity: string;
  country_code: string | null;
  /** Where the store's customers' phones are from, over its real orders. */
  customer_countries: AdminCustomerCountries;
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
  merchant_whatsapp_phone: string | null;
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
    /** Non-test verifications whose message was sent: the confirmation-rate denominator. */
    sent: number;
    by_status: Record<string, number>;
    failed_24h: number;
    total_24h: number;
  };
}

export interface AdminStoreVerificationView {
  id: string;
  status: string;
  reason: string | null;
  /** The provider's error code and title, for a failed verification only. */
  failure_code: string | null;
  failure_title: string | null;
  order_number: string | null;
  external_order_id: string;
  is_test: boolean;
  customer_name: string | null;
  customer_phone_masked: string;
  /** The country of the customer's phone, or null when it is unknown. */
  customer_country: string | null;
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
  private readonly logger = new Logger(AdminStoresService.name);

  constructor(
    private readonly repository: AdminQueryRepository,
    private readonly healthRules: AdminHealthRuleService,
    private readonly config: ConfigService,
    @Optional() private readonly integrations?: IntegrationsRepository,
    @Optional() private readonly templates?: WhatsappTemplatesRepository,
    @Optional() private readonly reviewPrompts?: ReviewPromptsRepository,
  ) {}

  async getStores(query: AdminStoresQueryDto) {
    const sort = query.sort ?? 'installed_at';
    const direction = query.direction ?? 'desc';
    const limit = query.limit ?? 50;
    const { summary, rows } = await this.repository.findStorePage(
      {
        search: query.search,
        platform: query.platform,
        plan: query.plan,
        lifecycleStatus: query.lifecycle_status,
        onboardingStatus: query.onboarding_status,
        healthStatus: query.health_status,
        country: query.country,
        customerCountry: query.customer_country,
        installedFrom: this.rangeStart(query.installed_from),
        installedTo: this.rangeEnd(query.installed_to),
        lastActivityFrom: this.rangeStart(query.last_activity_from),
        lastActivityTo: this.rangeEnd(query.last_activity_to),
      },
      {
        sort,
        direction,
        limit: limit + 1,
        cursor: this.decodeStoreCursor(query.cursor, sort, direction),
      },
      this.derivation(),
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      summary,
      data: page.map((row) => this.toView(row)),
      next_cursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                sort,
                direction,
                value: last.sort_value,
                id: last.integration_id,
              }),
            ).toString('base64url')
          : null,
      evaluated_at: new Date().toISOString(),
    };
  }

  async getStore(integrationId: string) {
    const row = await this.requireStore(integrationId);
    const totals =
      await this.repository.findStoreVerificationTotals(integrationId);
    return {
      store: this.toDetailView(row, totals),
      logo_header: await this.logoHeaderView(integrationId),
      review_prompt: await this.reviewPromptView(integrationId),
      evaluated_at: new Date().toISOString(),
    };
  }

  /**
   * Opens or closes the store's App Store review request and returns the new
   * view. Switching on an already pending store, or off a store with nothing
   * pending, changes nothing.
   */
  async setReviewPromptEnabled(
    audit: { userId: string; requestId?: string },
    integrationId: string,
    enabled: boolean,
  ) {
    const repository = this.reviewPrompts;
    if (!repository) throw new NotFoundException('Store not found.');
    const { outcome } = enabled
      ? await repository.enable(integrationId, audit)
      : await repository.disable(integrationId, audit);
    if (outcome === 'not_found')
      throw new NotFoundException('Store not found.');
    if (outcome === 'opted_out') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'The merchant asked not to be asked for a review again.',
        code: REVIEW_PROMPT_ADMIN_ERROR_CODES.optedOut,
      });
    }
    if (outcome === 'unsupported_platform') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Only Shopify stores can be asked for a review.',
        code: REVIEW_PROMPT_ADMIN_ERROR_CODES.unsupportedStore,
      });
    }
    this.logger.log(
      buildBackendLog(AdminStoresService.name, {
        action: 'admin-store-review-prompt-set',
        outcome: 'success',
        result: outcome,
        integrationId,
        enabled,
      }),
    );
    return { review_prompt: await this.reviewPromptView(integrationId) };
  }

  /**
   * Makes the store's review prompt eligible again after a snooze, decline,
   * click or review, and returns the new view. The switch is left as it is.
   */
  async resetReviewPrompt(
    audit: { userId: string; requestId?: string },
    integrationId: string,
  ) {
    const repository = this.reviewPrompts;
    if (!repository) throw new NotFoundException('Store not found.');
    const { outcome } = await repository.reset(integrationId, audit);
    if (outcome === 'not_found')
      throw new NotFoundException('Store not found.');
    if (outcome === 'unsupported_platform') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Only Shopify stores can be asked for a review.',
        code: REVIEW_PROMPT_ADMIN_ERROR_CODES.unsupportedStore,
      });
    }
    this.logger.log(
      buildBackendLog(AdminStoresService.name, {
        action: 'admin-store-review-prompt-reset',
        outcome: 'success',
        integrationId,
      }),
    );
    return { review_prompt: await this.reviewPromptView(integrationId) };
  }

  /**
   * The review switch, where the merchant stands, what the card would show
   * now and the latest events, for Shopify stores only. Undefined for other
   * stores.
   */
  private async reviewPromptView(integrationId: string) {
    const repository = this.reviewPrompts;
    const state = await repository?.findAdminState(integrationId);
    if (!repository || !state || state.platformType !== 'shopify') {
      return undefined;
    }
    const results = await repository
      .countStoreResults(state.orgId, integrationId)
      .catch(() => undefined);
    const row = state.state;
    const effective = effectiveReviewPromptState(row, new Date());
    const last = state.events[0];
    return {
      enabled: state.pending !== null,
      request_id: state.pending?.id ?? null,
      enabled_at: state.pending?.enabledAt ?? null,
      enabled_by: state.pending?.enabledBy ?? null,
      opted_out: effective === 'declined',
      opted_out_at: effective === 'declined' ? (row?.updatedAt ?? null) : null,
      state: effective,
      snoozed_until:
        effective === 'snoozed' ? (row?.snoozedUntil ?? null) : null,
      snooze_count: row?.snoozeCount ?? 0,
      shown_count: row?.shownCount ?? 0,
      last_shown_at: row?.lastShownAt ?? null,
      last_result_code: row?.lastResultCode ?? null,
      preview: {
        variant: reviewPromptVariantFor(results?.confirmed ?? null),
        confirmed: results?.confirmed ?? null,
        canceled: results?.canceled ?? null,
        since: results?.since ?? null,
      },
      last_event: last
        ? { event: last.event, actor_type: last.actorType, at: last.createdAt }
        : null,
      events: state.events.map((event) => ({
        id: event.id,
        request_id: event.requestId,
        event: event.event,
        actor_type: event.actorType,
        actor_id: event.actorId,
        result_code: event.resultCode,
        at: event.createdAt,
      })),
    };
  }

  /** Switches the store's logo header and returns the new view. */
  async setLogoHeaderEnabled(
    userId: string,
    integrationId: string,
    enabled: boolean,
  ) {
    const found = await this.integrations?.setLogoHeaderEnabled(
      integrationId,
      enabled,
      { userId },
    );
    if (!found) throw new NotFoundException('Store not found.');
    this.logger.log(
      buildBackendLog(AdminStoresService.name, {
        action: 'admin-store-logo-header-set',
        outcome: 'success',
        integrationId,
        enabled,
      }),
    );
    return { logo_header: await this.logoHeaderView(integrationId) };
  }

  /**
   * The store's logo, its switch and every image twin staff registered, so
   * staff can see why a store's messages carry no banner.
   */
  private async logoHeaderView(integrationId: string) {
    const [state, twins] = await Promise.all([
      this.integrations?.findLogoState(integrationId),
      this.templates
        ? this.templates.findImageTwins()
        : Promise.resolve<ImageTwinTemplate[]>([]),
    ]);
    return {
      enabled: state?.logoHeaderEnabled ?? false,
      logo_url: state?.logoUrl ?? null,
      banner_url: state?.logoBannerUrl ?? null,
      updated_at: state?.logoUpdatedAt ?? null,
      image_twins: twins.map((twin) => ({
        twin_of_key: twin.imageTwinOfKey,
        twin_of_template_name: twin.twinOf.templateName,
        template_name: twin.templateName,
        language_code: twin.languageCode,
        is_active: twin.isActive,
        review_status: twin.reviewStatus,
      })),
    };
  }

  async getUnconnectedStores() {
    const rows = await this.repository.findUnconnectedStores();
    return {
      data: rows.map((row) => ({
        platform: row.platform,
        shop_domain: row.store_domain,
        skipped_events: Number(row.skipped_events),
        unique_orders: Number(row.unique_orders),
        unique_orders_7d: Number(row.unique_orders_7d),
        first_received_at: row.first_received_at,
        last_received_at: row.last_received_at,
      })),
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
    const row = await this.repository.findStoreById(
      integrationId,
      this.derivation(),
    );
    if (!row) throw new NotFoundException('Store not found.');
    return row;
  }

  private toDetailView(
    row: AdminStoreDetailQueryRow,
    totals: Awaited<
      ReturnType<AdminQueryRepository['findStoreVerificationTotals']>
    >,
  ): AdminStoreDetailView {
    const view = this.toView(row);
    const byStatus: Record<string, number> = {};
    let total = 0;
    let test = 0;
    let sent = 0;
    for (const entry of totals) {
      const count = Number(entry.count ?? 0);
      if (entry.is_test) {
        test += count;
        continue;
      }
      total += count;
      sent += Number(entry.sent ?? 0);
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + count;
    }

    return {
      ...view,
      owner_email: row.owner_email,
      merchant_whatsapp_phone: row.merchant_whatsapp_phone,
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
          at: row.first_eligible_order_at_effective,
          estimated:
            row.first_eligible_estimated ||
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
          at: row.first_resolved_at_effective,
          estimated:
            row.first_resolved_estimated ||
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
        sent,
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
    const failed = row.status === 'failed';
    return {
      id: row.id,
      status: row.status,
      reason: readVerificationReason(row.metadata),
      failure_code: failed ? readProviderErrorCode(row.metadata) : null,
      failure_title: failed ? readProviderErrorTitle(row.metadata) : null,
      order_number: row.order_number,
      external_order_id: row.external_order_id,
      is_test: row.is_test,
      customer_name: row.customer_name,
      customer_phone_masked: maskPhone(row.customer_phone),
      customer_country: row.customer_country,
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

  private derivation(): AdminStoreDerivation {
    return {
      lowBalanceThreshold: readStandaloneCreditBillingConfig(this.config)
        .lowBalanceThreshold,
      planLimits: Object.fromEntries(
        PLAN_IDS.map((plan) => [plan, resolveIncludedVerificationsLimit(plan)]),
      ),
      healthSignals: (columns) => this.healthRules.signalsSql(columns),
    };
  }

  private rangeStart(value?: string): string | undefined {
    return value ? new Date(value).toISOString() : undefined;
  }

  private rangeEnd(value?: string): string | undefined {
    if (!value) return undefined;
    const endOfDay = /^\d{4}-\d{2}-\d{2}$/.test(value) ? 86_399_999 : 0;
    return new Date(new Date(value).getTime() + endOfDay).toISOString();
  }

  private decodeStoreCursor(
    cursor: string | undefined,
    sort: AdminStoreSortKey,
    direction: 'asc' | 'desc',
  ): { value: string; id: string } | undefined {
    if (!cursor) return undefined;
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString(),
      ) as Record<string, unknown>;
      if (
        parsed.sort !== sort ||
        parsed.direction !== direction ||
        typeof parsed.value !== 'string' ||
        typeof parsed.id !== 'string' ||
        !UUID_PATTERN.test(parsed.id)
      ) {
        throw new Error('Cursor does not match this query');
      }
      return { value: parsed.value, id: parsed.id };
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }

  private toView(row: AdminStoreViewRow): AdminStoreView {
    const plan = row.plan as PlanId | null;
    const used = Number(row.usage_used ?? 0);
    const limit = Number(row.usage_limit_effective ?? 0);
    const usage = {
      used,
      limit,
      remaining: Math.max(limit - used, 0),
      percent: Number(row.usage_percent ?? 0),
    };
    const billing: AdminStoreBilling =
      row.is_credit && row.credit_account_status && row.credit_balance_state
        ? {
            model: 'credits',
            account_status: row.credit_account_status,
            available: Number(row.credit_available ?? 0),
            held: Number(row.credit_held_credits ?? 0),
            debt: Number(row.credit_debt ?? 0),
            balance_state: row.credit_balance_state,
          }
        : {
            model: 'plan',
            plan,
            subscription_status: row.subscription_status,
            usage,
          };
    const signals = [...row.critical_signals, ...row.attention_signals];

    return {
      integration_id: row.integration_id,
      org_id: row.org_id,
      platform: row.platform_type,
      organization_name: row.organization_name,
      store_name: row.store_name ?? row.organization_name,
      shop_domain: row.platform_type === 'standalone' ? null : row.shop_domain,
      source_identity: row.shop_domain,
      country_code: row.country_code,
      customer_countries: {
        top: row.top_customer_country,
        share:
          row.top_customer_country_share === null
            ? null
            : Number(row.top_customer_country_share),
        count: Number(row.customer_country_count ?? 0),
      },
      timezone: row.timezone,
      installed_at: row.installed_at,
      lifecycle_status: row.lifecycle_status as AdminLifecycleStatus,
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
      first_eligible_real_order_at: row.first_eligible_order_at_effective,
      activated_at: row.first_resolved_at_effective,
      last_activity_at: row.last_activity_at,
      health: {
        status: row.health_status as AdminHealthStatus,
        top_signal: signals[0] ?? null,
        signal_count: signals.length,
        signals,
      },
      data_quality: row.data_quality_estimated
        ? ['estimated_historical_data']
        : [],
    };
  }
}
