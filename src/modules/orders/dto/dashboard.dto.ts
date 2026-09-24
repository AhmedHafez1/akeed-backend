import type { CreditDenialCode } from '../../../shared/billing/credit-eligibility';
import type { CommerceOutcomeOperationResult } from '../../../shared/commerce/commerce-outcome';
import type { VerificationRowCapability } from '../../../shared/verification/verification-row-actions';
import {
  VERIFICATION_LIST_TABS,
  type NeedsActionReason,
  type VerificationListTab,
} from '../../../shared/verification/verification-needs-action';
import type {
  MessageFunnel,
  UsageState,
} from '../../../shared/verification/verification-metrics';
import { TrimOptionalString } from '../../../shared/validation/trim.transform';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const DASHBOARD_DATE_RANGE_VALUES = [
  'today',
  'last_7_days',
  'last_30_days',
  'last_3_months',
] as const;

export type DashboardDateRange = (typeof DASHBOARD_DATE_RANGE_VALUES)[number];

export class GetVerificationsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsIn(DASHBOARD_DATE_RANGE_VALUES)
  date_range?: DashboardDateRange;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Show only the orders one import batch created.
   *
   * The whitelist strips anything not declared here, so the filter has to be
   * a field before the review link from an import can work.
   */
  @IsOptional()
  @IsUUID()
  importBatchId?: string;

  /** Confirmations tab, each a server-side filter. */
  @IsOptional()
  @IsIn(VERIFICATION_LIST_TABS)
  tab?: VerificationListTab;

  /** Order number or phone. Digits and phone punctuation only. */
  @IsOptional()
  @TrimOptionalString()
  @IsString()
  @MaxLength(32)
  @Matches(/^[#+\d\s()-]*$/)
  q?: string;
}

export class GetVerificationStatsQueryDto {
  @IsOptional()
  @IsIn(DASHBOARD_DATE_RANGE_VALUES)
  date_range?: DashboardDateRange;
}

export interface VerificationListItemDto {
  capabilities: VerificationRowCapability[];
  cancellation_operation?: CommerceOutcomeOperationResult;
  id: string;
  status: string;
  /**
   * Why the verification is in its current state, when a send/dispatch path
   * recorded one. Carries the explanation without inventing a status word for
   * it — the status vocabulary stays the nine the database can hold.
   */
  reason: string | null;
  order_id: string;
  order_number: string | null;
  is_test: boolean;
  customer_name: string | null;
  customer_phone: string | null;
  total_price: string | null;
  currency: string | null;
  created_at: string | null;
  last_sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  confirmed_at: string | null;
  canceled_at: string | null;
  expired_at: string | null;
  no_reply_at: string | null;
  follow_up_attempts: number;
  follow_up_sent_at: string | null;
  /** The order's id on its platform, for linking to it in the store admin. */
  external_order_id: string | null;
  platform: string | null;
  /** Why the merchant should act on this row; null when nothing is needed. */
  action_reason: NeedsActionReason | null;
  /** WhatsApp's error code when delivery failed (e.g. 131026). */
  failure_code: string | null;
  /** `merchant_manual` when the merchant confirmed by hand. */
  confirmation_source: 'customer' | 'merchant_manual' | null;
  cancellation_source: string | null;
  /** True once Akeed canceled the order in the store as well. */
  canceled_in_store: boolean;
  updated_at: string | null;
  /**
   * When a pending row's first message is deliberately delayed (quiet hours or
   * send delay), the time it is due to go out. Null once anything was sent.
   */
  scheduled_for: string | null;
}

/**
 * States the retry endpoint distinguishes when deciding whether a re-send is
 * safe.
 *
 * Not a merchant-facing vocabulary: the dashboard renders only the nine values
 * the `verification_status` enum can hold. The extra members here
 * (`accepted`, `processing`, `ineligible`, `blocked`, `review_required`)
 * describe an order that has not reached a verification yet, or one whose
 * dispatch outcome is unresolved — distinctions retry safety needs and the UI
 * does not. `awaiting_start` (held, nothing will be sent until released) and
 * `not_started` (withdrawn before release) are never retryable.
 */
export const RETRY_GUARD_STATUSES = [
  'awaiting_start',
  'not_started',
  'accepted',
  'processing',
  'ineligible',
  'blocked',
  'pending',
  'sent',
  'delivered',
  'read',
  'confirmed',
  'canceled',
  'expired',
  'failed',
  'no_reply',
  'review_required',
] as const;

export type RetryGuardStatus = (typeof RETRY_GUARD_STATUSES)[number];

export interface RetryGuardStateDto {
  status: RetryGuardStatus;
  reason: string | null;
  verification_id: string | null;
  retryable: boolean;
}

export interface RetryManualOrderVerificationResponseDto {
  orderId: string;
  verificationId?: string;
  lifecycle: RetryGuardStateDto;
  duplicate: boolean;
}

/**
 * Included verifications left in the current period.
 *
 * Reported alongside the permissions because the client needs both to decide
 * whether creating an order is offered at all: a merchant may hold the
 * permission and still have nothing left to spend it on. `remaining` is
 * pre-computed so no caller has to rediscover that it clamps at zero.
 */
export interface DashboardUsageBudgetDto {
  credit_denial?: CreditDenialCode | null;
  used: number;
  limit: number;
  remaining: number;
  period_end: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
  total_count?: number;
  page_context?: {
    source: DashboardSourceState;
    reporting_timezone?: string;
    automation: {
      is_auto_verify_enabled: boolean;
      follow_up_enabled: boolean;
      quiet_hours_enabled: boolean;
    };
    permissions?: {
      can_send_test_verification: boolean;
      can_cancel_orders: boolean;
      can_create_manual_order: boolean;
      can_retry_verifications?: boolean;
    };
    usage?: DashboardUsageBudgetDto;
    /** Rows per confirmations tab for the period, search ignored. */
    tab_counts?: Record<VerificationListTab, number>;
  };
}

export interface VerificationStatsDto {
  date_range: DashboardDateRange;
  /** IANA zone the date range was bucketed in; clients format rows with it. */
  reporting_timezone: string;
  source: DashboardSourceState;
  automation: {
    is_auto_verify_enabled: boolean;
    follow_up_enabled: boolean;
    quiet_hours_enabled: boolean;
  };
  totals: {
    total: number;
    in_progress: number;
    needs_attention: number;
    pending: number;
    failed: number;
    awaiting_reply: number;
    confirmed: number;
    canceled: number;
    customer_canceled: number;
    sent: number;
    delivered: number;
    read: number;
    follow_ups_sent: number;
    reply_rate: number;
    confirmation_rate: number;
  };
  usage: {
    used: number;
    limit: number;
    period_start: string | null;
    period_end: string | null;
    /** Real orders confirmed since the usage period started. */
    confirmed_in_period: number;
    confirmed_value_in_period: string;
  };
  savings: {
    avg_shipping_cost: number;
    currency: string;
    money_saved: number;
  };
}

export interface DashboardSourceState {
  status: 'connected' | 'disconnected' | 'not_connected';
  integration_id: string | null;
  platform_type: string | null;
}

export class GetVerificationOverviewQueryDto {
  @IsOptional()
  @IsIn(DASHBOARD_DATE_RANGE_VALUES)
  date_range?: DashboardDateRange;
}

export interface NeedsActionItemDto {
  verification_id: string;
  order_id: string;
  external_order_id: string | null;
  platform: string | null;
  order_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  total_price: string | null;
  currency: string | null;
  reason: {
    type: NeedsActionReason;
    /** First message time, or the read time for `read_no_reply`. */
    since: string | null;
    /** Whole hours since `since`. */
    hours: number | null;
    failure_code: string | null;
  };
  capabilities: VerificationRowCapability[];
}

/** Everything the embedded dashboard shows, from one request. */
export interface VerificationOverviewDto {
  date_range: DashboardDateRange;
  reporting_timezone: string;
  source: DashboardSourceState;
  settings: {
    auto_verify_enabled: boolean;
    follow_up_enabled: boolean;
    follow_up_delay_minutes: number;
    quiet_hours_enabled: boolean;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
  };
  /** Null when there is no single active source to bill. */
  usage: {
    used: number;
    limit: number;
    percent: number;
    state: UsageState;
  } | null;
  kpis: {
    confirmed: {
      count: number;
      /** Largest currency first; one entry per currency seen. */
      value: Array<{ currency: string; amount: string }>;
    };
    canceled_before_shipping: { count: number };
    confirmation_rate: {
      /** Percent of sent, one decimal; null when nothing was sent. */
      rate: number | null;
      confirmed: number;
      sent: number;
    };
  };
  funnel: MessageFunnel;
  needs_action: {
    count: number;
    items: NeedsActionItemDto[];
  };
  /** Added by the controller from the caller's role. */
  permissions?: { can_confirm_orders: boolean };
}
