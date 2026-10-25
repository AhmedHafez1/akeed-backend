import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  TIPS_CAMPAIGN_STATUSES,
  TIPS_CAMPAIGN_TYPES,
  TIPS_TARGETING_MODES,
  type TipsCampaignStatus,
  type TipsCampaignType,
  type TipsTargetingMode,
} from '../../../shared/tips-campaigns/tips-campaign.types';
import { TrimOptionalString } from '../../../shared/validation/trim.transform';

/**
 * These DTOs only bound the payload. The campaign rules (required fields,
 * lengths, line breaks, link safety, filter values) live in
 * `tips-campaign.policy.ts` and answer with a coded 422 listing each field,
 * which the global validation pipe could not do.
 */
const TEXT_STORE_LIMIT = 5000;

export class AdminTipsTranslationDto {
  @IsString()
  @MaxLength(8)
  locale!: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_STORE_LIMIT)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_STORE_LIMIT)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_STORE_LIMIT)
  action_label?: string | null;
}

export class AdminTipsActionDto {
  @IsString()
  @MaxLength(16)
  kind!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  route?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  url?: string;
}

export class AdminTipsAudienceDto {
  @IsIn(TIPS_TARGETING_MODES)
  mode!: TipsTargetingMode;

  /** Checked value by value in the policy, so it is kept whole here. */
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  selected_org_ids?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  excluded_org_ids?: string[];
}

export class AdminTipsCampaignCreateDto {
  @IsString()
  @MaxLength(TEXT_STORE_LIMIT)
  name!: string;

  @IsIn(TIPS_CAMPAIGN_TYPES)
  type!: TipsCampaignType;

  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AdminTipsTranslationDto)
  translations!: AdminTipsTranslationDto[];

  /** `null` or absent means no button. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AdminTipsActionDto)
  action?: AdminTipsActionDto | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  expires_at?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AdminTipsAudienceDto)
  audience?: AdminTipsAudienceDto;
}

/**
 * An edit names the revision it was made on. Fields left out stay as they
 * are; `action: null` removes the button and `expires_at: null` the expiry.
 */
export class AdminTipsCampaignUpdateDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_STORE_LIMIT)
  name?: string;

  @IsOptional()
  @IsIn(TIPS_CAMPAIGN_TYPES)
  type?: TipsCampaignType;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AdminTipsTranslationDto)
  translations?: AdminTipsTranslationDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AdminTipsActionDto)
  action?: AdminTipsActionDto | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  expires_at?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AdminTipsAudienceDto)
  audience?: AdminTipsAudienceDto;
}

export class AdminTipsPublishDto {
  @IsString()
  @MaxLength(200)
  review_token!: string;
}

export class AdminTipsListQueryDto {
  @IsOptional()
  @IsIn(TIPS_CAMPAIGN_STATUSES)
  status?: TipsCampaignStatus;

  @IsOptional()
  @TrimOptionalString()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class AdminTipsOrganizationsQueryDto {
  @IsOptional()
  @TrimOptionalString()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
