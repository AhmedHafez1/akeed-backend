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

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
}

export interface VerificationStatsDto {
  date_range: DashboardDateRange;
  totals: {
    confirmed: number;
    canceled: number;
    sent: number;
    delivered: number;
    read: number;
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
