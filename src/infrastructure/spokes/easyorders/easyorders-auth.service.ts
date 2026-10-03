import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EasyOrdersConnectionsRepository,
  isUsablePendingInstall,
  type EasyOrdersConnectionOverview,
  type EasyOrdersPendingInstall,
} from '../../database/repositories/easyorders-connections.repository';
import type { AuthenticatedUser } from '../../../modules/auth/guards/dual-auth.guard';
import {
  assertOrganizationWriteAllowed,
  canWriteOrganization,
} from '../../../modules/auth/organization-role';
import {
  isEasyOrdersPilotOrganization,
  readEasyOrdersConfig,
  type EasyOrdersConfig,
} from '../../../shared/config/easyorders.config';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import type {
  EasyOrdersConnectionState,
  EasyOrdersConnectionStatusDto,
  EasyOrdersInstallStartedDto,
  SaveEasyOrdersWebhookSecretsDto,
  StartEasyOrdersInstallDto,
} from './dto/easyorders-connection.dto';
import { EasyOrdersApiClient } from './easyorders-api.client';
import { buildEasyOrdersInstallLink } from './easyorders-install-link';
import {
  generateInstallToken,
  hashInstallToken,
  installTokenHint,
  isWellFormedInstallToken,
} from './easyorders-install-token';
import {
  EASYORDERS_ROLE_REQUIRED,
  easyOrdersError,
  type EasyOrdersErrorCode,
} from './easyorders.errors';

/** How long the seller has to accept on the EasyOrders consent page. */
export const EASYORDERS_INSTALL_TTL_MS = 15 * 60 * 1000;

const API_KEY_MAX_LENGTH = 512;
const STORE_ID_MAX_LENGTH = 128;
/** Printable ASCII without spaces: a key or an id, never free text. */
const OPAQUE_VALUE_PATTERN = /^[\x21-\x7E]+$/;

interface InstallCallbackBody {
  apiKey: string;
  storeId: string;
}

/**
 * Reads only the two documented fields and ignores anything else, which the
 * contract record lists as unknown. Nothing in the body is trusted beyond its
 * shape: the key is probed and the store id is stored as a claim.
 */
export function parseInstallCallbackBody(
  body: unknown,
): InstallCallbackBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { api_key: apiKey, store_id: storeId } = body as Record<
    string,
    unknown
  >;
  if (
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey.length > API_KEY_MAX_LENGTH ||
    !OPAQUE_VALUE_PATTERN.test(apiKey)
  )
    return null;
  if (
    typeof storeId !== 'string' ||
    storeId.length === 0 ||
    storeId.length > STORE_ID_MAX_LENGTH ||
    !OPAQUE_VALUE_PATTERN.test(storeId)
  )
    return null;
  return { apiKey, storeId };
}

/**
 * The EasyOrders install (US-06-02), as the US-06-01 contract record defines
 * it: an owner or admin of a source-less pilot organization opens a
 * single-use context, the seller accepts in EasyOrders, and the seller's
 * browser calls back with a key that is checked before anything is stored.
 */
@Injectable()
export class EasyOrdersAuthService {
  private readonly logger = new Logger(EasyOrdersAuthService.name);

  constructor(
    private readonly connections: EasyOrdersConnectionsRepository,
    private readonly api: EasyOrdersApiClient,
    private readonly config: ConfigService,
  ) {}

  async startInstall(
    user: AuthenticatedUser,
    input: StartEasyOrdersInstallDto,
  ): Promise<EasyOrdersInstallStartedDto> {
    const settings = this.assertCanConnect(user);

    const callbackToken = generateInstallToken();
    const webhookToken = generateInstallToken();
    const result = await this.connections.createPendingInstall({
      orgId: user.orgId,
      createdBy: user.userId,
      callbackTokenHash: hashInstallToken(callbackToken),
      webhookTokenHash: hashInstallToken(webhookToken),
      webhookTokenHint: installTokenHint(webhookToken),
      expiresAt: new Date(Date.now() + EASYORDERS_INSTALL_TTL_MS).toISOString(),
    });
    if (result.kind === 'source_exists') {
      this.logger.warn(
        buildBackendLog(EasyOrdersAuthService.name, {
          action: 'easyorders-install-start',
          outcome: 'skipped',
          orgId: user.orgId,
          userId: user.userId,
          errorCode: 'EASYORDERS_SOURCE_EXISTS',
        }),
      );
      throw easyOrdersError('EASYORDERS_SOURCE_EXISTS');
    }

    this.logger.log(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-install-start',
        outcome: 'success',
        orgId: user.orgId,
        userId: user.userId,
        pendingInstallId: result.pending.id,
      }),
    );
    return {
      installUrl: buildEasyOrdersInstallLink({
        publicApiBaseUrl: settings.publicApiBaseUrl,
        appBaseUrl: settings.appBaseUrl,
        callbackToken,
        webhookToken,
        locale: input.locale,
      }),
      expiresAt: result.pending.expiresAt,
    };
  }

  /**
   * The public callback. The path token is the only thing that binds the
   * request to a tenant, so every way it can be wrong gets the same answer,
   * and nothing in the request is echoed back or logged.
   */
  async handleCallback(token: string, body: unknown): Promise<void> {
    const settings = readEasyOrdersConfig(this.config);
    if (!settings.enabled)
      throw easyOrdersError('EASYORDERS_CONNECT_UNAVAILABLE');

    const pending = isWellFormedInstallToken(token)
      ? await this.connections.findPendingByCallbackTokenHash(
          hashInstallToken(token),
        )
      : undefined;
    if (
      !pending ||
      !isUsablePendingInstall(pending, new Date()) ||
      !isEasyOrdersPilotOrganization(settings, pending.orgId)
    ) {
      this.logger.warn(
        buildBackendLog(EasyOrdersAuthService.name, {
          action: 'easyorders-install-callback',
          outcome: 'failure',
          orgId: pending?.orgId,
          pendingInstallId: pending?.id,
          errorCode: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
        }),
      );
      throw easyOrdersError('EASYORDERS_INSTALL_CONTEXT_INVALID');
    }

    const parsed = parseInstallCallbackBody(body);
    if (!parsed)
      throw await this.reject(pending, 'EASYORDERS_CALLBACK_INVALID');

    if (
      await this.connections.isStoreVerifiedForAnotherOrganization(
        parsed.storeId,
        pending.orgId,
      )
    )
      throw await this.reject(pending, 'EASYORDERS_STORE_UNAVAILABLE');

    // Outside any transaction: a slow provider must not hold row locks.
    const probe = await this.api.probeKey(parsed.apiKey);
    if (probe === 'unavailable')
      throw await this.reject(pending, 'EASYORDERS_PROVIDER_UNAVAILABLE');
    if (probe === 'rejected')
      throw await this.reject(pending, 'EASYORDERS_KEY_REJECTED');

    const result = await this.connections.connect({
      pendingInstallId: pending.id,
      storeId: parsed.storeId,
      apiKeyEncrypted: encryptToken(parsed.apiKey, this.encryptionKey()),
      health: probe === 'store_inactive' ? 'store_inactive' : 'ok',
    });
    if (result.kind === 'context_invalid')
      throw await this.reject(pending, 'EASYORDERS_INSTALL_CONTEXT_INVALID', {
        countAttempt: false,
      });
    if (result.kind === 'source_exists')
      throw await this.reject(pending, 'EASYORDERS_SOURCE_EXISTS');
    if (result.kind === 'store_unavailable')
      throw await this.reject(pending, 'EASYORDERS_STORE_UNAVAILABLE');

    this.logger.log(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-install-callback',
        outcome: 'success',
        orgId: result.orgId,
        integrationId: result.integrationId,
        pendingInstallId: pending.id,
        connectionHealth: probe === 'store_inactive' ? 'store_inactive' : 'ok',
      }),
    );
  }

  /** Any member may read the status; it never contains a credential. */
  async getStatus(
    user: AuthenticatedUser,
  ): Promise<EasyOrdersConnectionStatusDto> {
    const settings = readEasyOrdersConfig(this.config);
    const overview = await this.connections.getOverview(user.orgId);
    return this.toStatus(user, settings, overview);
  }

  /**
   * The seller copies the two webhook secrets from their EasyOrders dashboard
   * (contract record section 7). They are encrypted and write-only.
   */
  async saveWebhookSecrets(
    user: AuthenticatedUser,
    input: SaveEasyOrdersWebhookSecretsDto,
  ): Promise<EasyOrdersConnectionStatusDto> {
    assertOrganizationWriteAllowed(user.role, EASYORDERS_ROLE_REQUIRED);
    const key = this.encryptionKey();
    const saved = await this.connections.saveWebhookSecrets(user.orgId, {
      ordersWebhookSecretEncrypted: encryptToken(input.ordersSecret, key),
      statusWebhookSecretEncrypted: encryptToken(input.statusSecret, key),
    });
    if (!saved) throw easyOrdersError('EASYORDERS_NOT_CONNECTED');

    this.logger.log(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-webhook-secrets-save',
        outcome: 'success',
        orgId: user.orgId,
        userId: user.userId,
      }),
    );
    return this.getStatus(user);
  }

  private assertCanConnect(user: AuthenticatedUser): EasyOrdersConfig {
    // An embedded Shopify session always has a Shopify source already.
    if (user.source !== 'supabase')
      throw easyOrdersError('EASYORDERS_SESSION_REQUIRED');
    assertOrganizationWriteAllowed(user.role, EASYORDERS_ROLE_REQUIRED);
    const settings = readEasyOrdersConfig(this.config);
    if (!settings.enabled)
      throw easyOrdersError('EASYORDERS_CONNECT_UNAVAILABLE');
    if (!isEasyOrdersPilotOrganization(settings, user.orgId))
      throw easyOrdersError('EASYORDERS_PILOT_REQUIRED');
    return settings;
  }

  private async reject(
    pending: EasyOrdersPendingInstall,
    code: EasyOrdersErrorCode,
    options: { countAttempt: boolean } = { countAttempt: true },
  ): Promise<HttpException> {
    if (options.countAttempt)
      await this.connections.recordFailedAttempt(pending.id, code);
    this.logger.warn(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-install-callback',
        outcome: 'failure',
        orgId: pending.orgId,
        pendingInstallId: pending.id,
        errorCode: code,
      }),
    );
    return easyOrdersError(code);
  }

  private toStatus(
    user: AuthenticatedUser,
    settings: EasyOrdersConfig,
    overview: EasyOrdersConnectionOverview,
  ): EasyOrdersConnectionStatusDto {
    const { connection, latestPending } = overview;
    const base = {
      canManage: user.source === 'supabase' && canWriteOrganization(user.role),
      organizationName: overview.organizationName,
      expiresAt: null,
      lastErrorCode: null,
      connection: null,
    };
    if (connection)
      return {
        ...base,
        state: 'connected',
        connection: {
          storeId: connection.storeId,
          storeVerified: connection.storeVerifiedAt !== null,
          health:
            connection.health === 'store_inactive' ? 'store_inactive' : 'ok',
          webhookUrlHint: connection.webhookTokenHint,
          ordersSecretSet: connection.ordersWebhookSecretEncrypted !== null,
          statusSecretSet: connection.statusWebhookSecretEncrypted !== null,
          connectedAt: connection.createdAt,
        },
      };
    if (!settings.enabled) return { ...base, state: 'unavailable' };
    if (overview.sourcePlatforms.length > 0)
      return { ...base, state: 'source_exists' };
    if (!isEasyOrdersPilotOrganization(settings, user.orgId))
      return { ...base, state: 'pilot_required' };
    return { ...base, ...pendingState(latestPending, new Date()) };
  }

  private encryptionKey(): string {
    return this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY');
  }
}

/**
 * What the organization's latest install context says. A refused callback
 * shows as `failed` even while the link could still be retried: the seller
 * saw an error in EasyOrders and needs to know why.
 */
function pendingState(
  pending: EasyOrdersPendingInstall | undefined,
  now: Date,
): Pick<
  EasyOrdersConnectionStatusDto,
  'state' | 'expiresAt' | 'lastErrorCode'
> {
  const none = { expiresAt: null, lastErrorCode: null };
  if (!pending || pending.consumedAt || pending.supersededAt)
    return { state: 'ready' satisfies EasyOrdersConnectionState, ...none };
  if (pending.lastErrorCode)
    return {
      state: 'failed',
      expiresAt: null,
      lastErrorCode: pending.lastErrorCode,
    };
  if (!isUsablePendingInstall(pending, now))
    return { state: 'expired', ...none };
  return {
    state: 'pending',
    expiresAt: pending.expiresAt,
    lastErrorCode: null,
  };
}
