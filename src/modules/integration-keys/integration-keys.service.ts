import { Injectable, Logger } from '@nestjs/common';
import {
  IntegrationApiKeyPrefixTakenError,
  IntegrationApiKeysRepository,
  type IntegrationApiKeyMetadata,
} from '../../infrastructure/database/repositories/integration-api-keys.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { API_KEY_SOURCE_CODES } from '../order-ingestion/standalone-source-resolver';
import type {
  CreateIntegrationApiKeyDto,
  CreatedIntegrationApiKeyDto,
  IntegrationApiKeyDto,
  IntegrationApiKeyListDto,
} from './dto/integration-api-key.dto';
import { generateIntegrationApiKey } from './integration-api-key.secret';
import { integrationKeyError } from './integration-keys.errors';

/** Enough for a zero-downtime rotation and a spare; the list stays small. */
export const MAX_ACTIVE_INTEGRATION_API_KEYS = 5;
/** Revoked keys accumulate; the list shows the most recent ones. */
export const INTEGRATION_API_KEY_LIST_LIMIT = 50;
/** A prefix collision is astronomically rare; a few draws settle it. */
const PREFIX_ATTEMPTS = 3;

/**
 * Issues, lists and revokes integration API keys (US-05-01).
 *
 * A key is a credential for exactly one Standalone source: the one the
 * shared resolver returns for the caller's organization. Nothing here queries
 * integrations itself.
 */
@Injectable()
export class IntegrationKeysService {
  private readonly logger = new Logger(IntegrationKeysService.name);

  constructor(
    private readonly keys: IntegrationApiKeysRepository,
    private readonly ingestion: StandaloneOrderIngestionService,
  ) {}

  /** Any member may read the metadata; viewers are read-only, not blind. */
  async list(user: AuthenticatedUser): Promise<IntegrationApiKeyListDto> {
    const rows = await this.keys.listByOrg(
      user.orgId,
      INTEGRATION_API_KEY_LIST_LIMIT,
    );
    return {
      keys: rows.map(toDto),
      maxActive: MAX_ACTIVE_INTEGRATION_API_KEYS,
    };
  }

  async create(
    user: AuthenticatedUser,
    input: CreateIntegrationApiKeyDto,
  ): Promise<CreatedIntegrationApiKeyDto> {
    const source = await this.ingestion.resolveWritableSource(
      user,
      API_KEY_SOURCE_CODES,
    );

    for (let attempt = 1; ; attempt++) {
      const generated = generateIntegrationApiKey();
      try {
        const result = await this.keys.createWithinCap(
          {
            orgId: user.orgId,
            integrationId: source.id,
            prefix: generated.prefix,
            keyHash: generated.keyHash,
            name: input.name,
            createdBy: user.userId,
          },
          MAX_ACTIVE_INTEGRATION_API_KEYS,
        );
        if (result.kind === 'limit_reached') {
          this.logger.warn(
            buildBackendLog(IntegrationKeysService.name, {
              action: 'integration-api-key-create',
              outcome: 'failure',
              orgId: user.orgId,
              userId: user.userId,
              integrationId: source.id,
              errorCode: 'API_KEY_LIMIT_REACHED',
            }),
          );
          throw integrationKeyError('API_KEY_LIMIT_REACHED', {
            maxActive: MAX_ACTIVE_INTEGRATION_API_KEYS,
          });
        }
        this.logger.log(
          buildBackendLog(IntegrationKeysService.name, {
            action: 'integration-api-key-create',
            outcome: 'success',
            orgId: user.orgId,
            userId: user.userId,
            integrationId: source.id,
            keyId: result.key.id,
            keyPrefix: result.key.prefix,
          }),
        );
        return { key: toDto(result.key), secret: generated.plaintext };
      } catch (error) {
        if (
          error instanceof IntegrationApiKeyPrefixTakenError &&
          attempt < PREFIX_ATTEMPTS
        )
          continue;
        throw error;
      }
    }
  }

  /**
   * Revocation needs the role, not a ready source: an owner must be able to
   * cut a leaked key off even while the store is disabled or mid-setup.
   */
  async revoke(
    user: AuthenticatedUser,
    keyId: string,
  ): Promise<IntegrationApiKeyDto> {
    this.ingestion.assertWritableRole(user, API_KEY_SOURCE_CODES);
    const result = await this.keys.revoke(user.orgId, keyId, user.userId);
    if (result.kind === 'not_found')
      throw integrationKeyError('API_KEY_NOT_FOUND');
    this.logger.log(
      buildBackendLog(IntegrationKeysService.name, {
        action: 'integration-api-key-revoke',
        outcome: result.kind === 'revoked' ? 'success' : 'skipped',
        orgId: user.orgId,
        userId: user.userId,
        integrationId: result.key.integrationId,
        keyId: result.key.id,
        keyPrefix: result.key.prefix,
        ...(result.kind === 'already_revoked'
          ? { reason: 'already_revoked' }
          : {}),
      }),
    );
    return toDto(result.key);
  }
}

function toDto(row: IntegrationApiKeyMetadata): IntegrationApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.revokedAt ? 'revoked' : 'active',
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}
