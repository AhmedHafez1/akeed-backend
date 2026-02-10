import { IsOptional, IsString } from 'class-validator';

export class GetVerificationsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;
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
