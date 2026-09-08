import type { CommerceOutcomeOperationResult } from '../../../shared/commerce/commerce-outcome';
import type { VerificationRowCapability } from '../../../shared/verification/verification-row-actions';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
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
}

/**
 * States the retry endpoint distinguishes when deciding whether a re-send is
 * safe.
 *
 * Not a merchant-facing vocabulary: the dashboard renders only the nine values
 * the `verification_status` enum can hold. The five extra members here
 * (`accepted`, `processing`, `ineligible`, `blocked`, `review_required`)
 * describe an order that has not reached a verification yet, or one whose
 * dispatch outcome is unresolved — distinctions retry safety needs and the UI
 * does not.
 */
export const RETRY_GUARD_STATUSES = [
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
