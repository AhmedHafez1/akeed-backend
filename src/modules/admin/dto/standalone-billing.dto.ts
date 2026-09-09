import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TrimString } from '../../../shared/validation/trim.transform';
import type { ApprovalStatus } from '../standalone-billing.types';

export const APPROVAL_STATUSES = [
  'eligible',
  'already_approved',
  'skipped',
  'ambiguous',
] as const satisfies readonly ApprovalStatus[];

export class StandaloneBillingAccountsDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsIn(APPROVAL_STATUSES) approval?: ApprovalStatus;
}

export class StandaloneApprovalPreviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  organizationIds!: string[];
}

export class StandaloneApprovalApplyDto {
  @IsUUID() previewId!: string;
  @TrimString()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
