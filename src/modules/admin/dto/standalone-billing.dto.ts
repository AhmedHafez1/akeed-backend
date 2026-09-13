import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { CreditAccountStatus } from '../../../shared/ports/credit-accounting.port';
import {
  BALANCE_FILTERS,
  RECONCILIATION_FILTERS,
  type BalanceFilter,
  type ReconciliationFilter,
} from '../standalone-billing-operations.types';

export const ACCOUNT_STATUSES = [
  'active',
  'suspended',
] as const satisfies readonly CreditAccountStatus[];

export class StandaloneBillingAccountsDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional()
  @IsIn(ACCOUNT_STATUSES)
  accountStatus?: CreditAccountStatus;
  @IsOptional() @IsIn(BALANCE_FILTERS) balance?: BalanceFilter;
  @IsOptional()
  @IsIn(RECONCILIATION_FILTERS)
  reconciliation?: ReconciliationFilter;
}
