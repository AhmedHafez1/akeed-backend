import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TrimString } from '../../../shared/validation/trim.transform';

export const ORGANIZATION_SOURCE_MODES = ['standalone', 'connect'] as const;
export type OrganizationSourceMode = (typeof ORGANIZATION_SOURCE_MODES)[number];

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @TrimString()
  name!: string;

  /**
   * How the organization gets its commerce source. `standalone` (default)
   * provisions the Standalone source with it. `connect` creates the
   * organization alone, for a merchant who chose at signup to connect a
   * store platform; the source is provisioned by that platform's install.
   */
  @IsOptional()
  @IsIn(ORGANIZATION_SOURCE_MODES)
  sourceMode?: OrganizationSourceMode;
}

export interface OrganizationResponseDto {
  id: string;
  name: string;
  slug: string;
  plan_type: string | null;
  /** Read only: kept for existing readers; no route writes these any more. */
  wa_phone_number_id: string | null;
  wa_business_account_id: string | null;
  wa_access_token_configured: boolean;
}
