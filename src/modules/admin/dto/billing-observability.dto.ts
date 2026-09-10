import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  TrimOptionalString,
  TrimString,
} from '../../../shared/validation/trim.transform';

const MAX_SAFE_MONEY = Number.MAX_SAFE_INTEGER;
const FINDING_STATUSES = ['open', 'resolved'] as const;
const FINDING_SEVERITIES = ['attention', 'critical'] as const;

export class BillingHealthQueryDto {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export class BillingFindingsQueryDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional()
  @IsIn(FINDING_STATUSES)
  status?: (typeof FINDING_STATUSES)[number];
  @IsOptional()
  @IsIn(FINDING_SEVERITIES)
  severity?: (typeof FINDING_SEVERITIES)[number];
  @IsOptional()
  @TrimOptionalString()
  @Matches(/^[a-z0-9_]{1,80}$/)
  code?: string;
}

export class BillingSettlementsQueryDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
}

export class BillingReconciliationRunDto {
  @TrimString()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class BillingSettlementDto extends BillingReconciliationRunDto {
  @TrimString()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:\-/]+$/)
  providerReportId!: string;

  @IsOptional() @IsUUID() supersedesId?: string;
  @IsISO8601({ strict: true }) periodStart!: string;
  @IsISO8601({ strict: true }) periodEnd!: string;
  @IsISO8601({ strict: true }) settledAt!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_MONEY)
  transactionCount!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(MAX_SAFE_MONEY) grossMinor!: number;
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_MONEY)
  refundedMinor!: number;
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_MONEY)
  chargebackMinor!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(MAX_SAFE_MONEY) feeMinor!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(MAX_SAFE_MONEY) vatMinor!: number;
  @Type(() => Number)
  @IsInt()
  @Min(-MAX_SAFE_MONEY)
  @Max(MAX_SAFE_MONEY)
  netMinor!: number;

  @TrimString()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  evidence!: string;
}
