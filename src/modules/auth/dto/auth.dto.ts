export class AuthOrganizationDto {
  id!: string;
  name!: string;
  slug!: string;
  plan_type!: string;
}

export class MeResponseDto {
  user_id!: string;
  org_id!: string;
  source!: 'shopify' | 'supabase';
  shop?: string;
  organization?: AuthOrganizationDto;
}

export class AuthStatusResponseDto {
  authenticated!: boolean;
  source!: string;
}
