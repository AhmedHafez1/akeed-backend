import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { TrimString } from '../../../shared/validation/trim.transform';

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @TrimString()
  name!: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  wa_phone_number_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  wa_business_account_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  wa_access_token?: string;
}

export interface OrganizationResponseDto {
  id: string;
  name: string;
  slug: string;
  plan_type: string | null;
  wa_phone_number_id: string | null;
  wa_business_account_id: string | null;
  wa_access_token_configured: boolean;
}
