import {
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * What the signup page knows right after Supabase created the account. The
 * email is deliberately absent: the backend reads it from the account, so a
 * caller cannot attach someone else's address to a conversion.
 */
export class CompleteRegistrationDto {
  /** A UUID from the page; any short token is accepted for older browsers. */
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9-]+$/)
  eventId!: string;

  @IsUUID()
  userId!: string;

  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  @MaxLength(2048)
  eventSourceUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  fbp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  fbc?: string;
}

export interface CompleteRegistrationResponseDto {
  accepted: true;
}
