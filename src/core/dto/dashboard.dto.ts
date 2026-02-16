import { IsIn, IsOptional, IsString } from 'class-validator';

export const DASHBOARD_DATE_RANGE_VALUES = [
  'today',
  'last_7_days',
  'last_30_days',
] as const;

export type DashboardDateRange = (typeof DASHBOARD_DATE_RANGE_VALUES)[number];

export class GetVerificationsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;
}

export class GetVerificationStatsQueryDto {
  @IsOptional()
  @IsIn(DASHBOARD_DATE_RANGE_VALUES)
  date_range?: DashboardDateRange;
}

export interface VerificationListItemDto {
  id: string;
  status: string;
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  total_price: string | null;
  currency: string | null;
  created_at: string | null;
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
  verification_status: string | null;
}

export interface VerificationStatsDto {
  date_range: DashboardDateRange;
  totals: {
    total: number;
    pending: number;
    confirmed: number;
    canceled: number;
    expired: number;
    reply_rate: number;
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
