import { IsString, Length, Matches } from 'class-validator';
import { TrimString } from '../../../shared/validation/trim.transform';

export const INTEGRATION_API_KEY_NAME_MAX_LENGTH = 60;

export class CreateIntegrationApiKeyDto {
  /** A label for the merchant, e.g. the server that will hold the key. */
  @TrimString()
  @IsString({ message: 'name must be text.' })
  @Length(1, INTEGRATION_API_KEY_NAME_MAX_LENGTH, {
    message: `name must be 1 to ${INTEGRATION_API_KEY_NAME_MAX_LENGTH} characters.`,
  })
  @Matches(/^[^\p{Cc}]*$/u, {
    message: 'name must not contain control characters.',
  })
  name!: string;
}

/** Key metadata. Never carries the secret or its hash. */
export interface IntegrationApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IntegrationApiKeyListDto {
  keys: IntegrationApiKeyDto[];
  /** Active keys one store may hold at a time. */
  maxActive: number;
}

/** The only response that ever contains the full key, once. */
export interface CreatedIntegrationApiKeyDto {
  key: IntegrationApiKeyDto;
  secret: string;
}
