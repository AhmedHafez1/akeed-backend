import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const PLANS = ['starter', 'basic', 'pro', 'business'] as const;
const LIFECYCLES = [
  'installed',
  'onboarding',
  'active',
  'inactive',
  'uninstalled',
] as const;
const HEALTH = ['healthy', 'attention_required', 'critical'] as const;
const ONBOARDING = ['pending', 'completed'] as const;
const SORTS = [
  'installed_at',
  'store_name',
  'last_activity',
  'usage_percent',
  'activation_date',
  'health',
] as const;

export class AdminStoresQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(PLANS)
  plan?: (typeof PLANS)[number];

  @IsOptional()
  @IsIn(LIFECYCLES)
  lifecycle_status?: (typeof LIFECYCLES)[number];

  @IsOptional()
  @IsIn(ONBOARDING)
  onboarding_status?: (typeof ONBOARDING)[number];

  @IsOptional()
  @IsIn(HEALTH)
  health_status?: (typeof HEALTH)[number];

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsDateString()
  installed_from?: string;

  @IsOptional()
  @IsDateString()
  installed_to?: string;

  @IsOptional()
  @IsDateString()
  last_activity_from?: string;

  @IsOptional()
  @IsDateString()
  last_activity_to?: string;

  @IsOptional()
  @IsIn(SORTS)
  sort?: (typeof SORTS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class AdminFunnelQueryDto {
  @IsOptional()
  @IsDateString()
  installed_from?: string;

  @IsOptional()
  @IsDateString()
  installed_to?: string;

  @IsOptional()
  @IsIn(PLANS)
  plan?: (typeof PLANS)[number];

  @IsOptional()
  @IsString()
  country?: string;
}
