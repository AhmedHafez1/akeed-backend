import type {
  CommerceOutcomeAction,
  CommerceOutcomeOperationResult,
} from '../../../shared/commerce/commerce-outcome';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const DASHBOARD_DATE_RANGE_VALUES = [
  'today',
  'last_7_days',
  'last_30_days',
  'last_3_months',
] as const;

export type DashboardDateRange = (typeof DASHBOARD_DATE_RANGE_VALUES)[number];

export class GetOrdersQueryDto {
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
  capabilities: { action: CommerceOutcomeAction; supported: boolean }[];
  cancellation_operation?: CommerceOutcomeOperationResult;
  id: string;
  status: string;
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

export interface OrderListItemDto {
  id: string;
  order_number: string | null;
  external_order_id: string;
  customer_name: string | null;
  customer_phone: string;
  customer_email: string | null;
  total_price: string | null;
  currency: string | null;
  created_at: string | null;
  is_test: boolean;
  source: {
    integration_id: string;
    platform_type: string;
  };
  verification_status: string | null;
  verification: {
    id: string;
    status: string;
    capabilities: {
      action: CommerceOutcomeAction;
      supported: boolean;
    }[];
    cancellation_operation?: CommerceOutcomeOperationResult;
    last_sent_at: string | null;
    delivered_at: string | null;
    read_at: string | null;
    confirmed_at: string | null;
    canceled_at: string | null;
    expired_at: string | null;
    no_reply_at: string | null;
    follow_up_attempts: number;
    follow_up_sent_at: string | null;
  } | null;
  lifecycle: ManualOrderLifecycleDto;
}

export const MANUAL_ORDER_LIFECYCLE_STATUSES = [
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

export type ManualOrderLifecycleStatus =
  (typeof MANUAL_ORDER_LIFECYCLE_STATUSES)[number];

export interface ManualOrderLifecycleDto {
  status: ManualOrderLifecycleStatus;
  reason: string | null;
  verification_id: string | null;
  retryable: boolean;
}

export interface RetryManualOrderVerificationResponseDto {
  orderId: string;
  verificationId?: string;
  lifecycle: ManualOrderLifecycleDto;
  duplicate: boolean;
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
  };
}

export interface StandaloneDashboardStatsDto {
  date_range: DashboardDateRange;
  reporting_timezone: string;
  source: DashboardSourceState;
  automation: VerificationStatsDto['automation'];
  order_totals: {
    total: number;
    in_progress: number;
    needs_attention: number;
    confirmed: number;
    canceled: number;
  };
  verification_totals: VerificationStatsDto['totals'];
  usage: VerificationStatsDto['usage'] & {
    period_start: string | null;
    period_end: string | null;
  };
  savings: VerificationStatsDto['savings'];
}

export interface VerificationStatsDto {
  date_range: DashboardDateRange;
  source: DashboardSourceState;
  automation: {
    is_auto_verify_enabled: boolean;
    follow_up_enabled: boolean;
    quiet_hours_enabled: boolean;
  };
  totals: {
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
