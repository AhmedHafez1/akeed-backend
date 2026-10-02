import {
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { IntegrationApiKeysRepository } from '../../../infrastructure/database/repositories/integration-api-keys.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  INTEGRATION_API_KEY_PREFIX_LABEL,
  matchesIntegrationApiKeyHash,
  parseIntegrationApiKey,
} from '../integration-api-key.secret';
import type { RequestWithIntegrationApiKey } from '../integration-api-key.principal';
import { integrationKeyError } from '../integration-keys.errors';

/** `last_used_at` is written at most this often per key. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * Query parameters a client might put a key in. Keys in URLs end up in proxy,
 * CDN and browser logs, so such a request is refused even when the header
 * also carries a valid key.
 */
const KEY_QUERY_PARAMETERS = new Set([
  'api_key',
  'apikey',
  'api-key',
  'key',
  'access_token',
  'token',
  'authorization',
]);

const BEARER_PATTERN = /^Bearer ([^\s]+)$/;

type FailureReason =
  | 'query_string'
  | 'missing_header'
  | 'malformed'
  | 'unknown'
  | 'mismatch'
  | 'revoked';

/**
 * Authenticates a server request by its integration API key (US-05-01).
 *
 * It accepts only `Authorization: Bearer <key>`, finds the key by its
 * non-secret prefix, compares the secret's hash in constant time and refuses
 * revoked keys. Every failure is the same 401 `API_KEY_INVALID`, so a caller
 * cannot tell a revoked key from a mistyped one. On success it attaches
 * `{orgId, integrationId, keyId, prefix}`; it never builds an ingestion
 * context and never passes through `DualAuthGuard`.
 */
@Injectable()
export class IntegrationApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(IntegrationApiKeyGuard.name);

  constructor(private readonly keys: IntegrationApiKeysRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithIntegrationApiKey>();

    if (carriesKeyInQuery(request.query)) this.deny(request, 'query_string');

    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length === 0)
      this.deny(request, 'missing_header');
    const token = BEARER_PATTERN.exec(header)?.[1];
    const parsed = token ? parseIntegrationApiKey(token) : null;
    if (!parsed) this.deny(request, 'malformed');

    const credential = await this.keys.findByPrefixForAuthentication(
      parsed.prefix,
    );
    // Hash and compare even when the prefix is unknown, so both paths cost
    // the same.
    const matches = matchesIntegrationApiKeyHash(
      parsed.secret,
      credential?.keyHash ?? null,
    );
    if (!credential) this.deny(request, 'unknown', parsed.prefix);
    if (!matches) this.deny(request, 'mismatch', parsed.prefix);
    if (credential.revokedAt) this.deny(request, 'revoked', parsed.prefix);

    request.integrationApiKey = {
      orgId: credential.orgId,
      integrationId: credential.integrationId,
      keyId: credential.id,
      prefix: credential.prefix,
    };

    if (isStale(credential.lastUsedAt)) {
      try {
        await this.keys.touchLastUsed(credential.id);
      } catch (error) {
        // Usage tracking is advisory; it never fails an authenticated call.
        this.logger.warn(
          buildBackendLog(IntegrationApiKeyGuard.name, {
            action: 'integration-api-key-touch',
            outcome: 'failure',
            orgId: credential.orgId,
            keyId: credential.id,
            keyPrefix: credential.prefix,
            ...normalizeError(error),
          }),
        );
      }
    }
    return true;
  }

  private deny(
    request: RequestWithIntegrationApiKey,
    reason: FailureReason,
    keyPrefix?: string,
  ): never {
    this.logger.warn(
      buildBackendLog(IntegrationApiKeyGuard.name, {
        action: 'integration-api-key-authenticate',
        outcome: 'failure',
        requestId: requestIdOf(request),
        errorCode: reason,
        keyPrefix,
      }),
    );
    throw integrationKeyError('API_KEY_INVALID');
  }
}

function carriesKeyInQuery(query: unknown): boolean {
  if (!query || typeof query !== 'object') return false;
  return Object.entries(query as Record<string, unknown>).some(
    ([name, value]) =>
      KEY_QUERY_PARAMETERS.has(name.toLowerCase()) || containsKeyLabel(value),
  );
}

function containsKeyLabel(value: unknown): boolean {
  if (typeof value === 'string')
    return value.toLowerCase().includes(INTEGRATION_API_KEY_PREFIX_LABEL);
  if (Array.isArray(value)) return value.some(containsKeyLabel);
  if (value && typeof value === 'object')
    return Object.values(value).some(containsKeyLabel);
  return false;
}

function isStale(lastUsedAt: string | null): boolean {
  if (!lastUsedAt) return true;
  const last = Date.parse(lastUsedAt);
  return Number.isNaN(last) || Date.now() - last >= LAST_USED_WRITE_INTERVAL_MS;
}

function requestIdOf(
  request: RequestWithIntegrationApiKey,
): string | undefined {
  const value = request.headers['x-request-id'];
  return Array.isArray(value) ? value[0] : value;
}
