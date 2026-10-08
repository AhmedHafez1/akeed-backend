import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EasyOrdersConnectionsRepository,
  isUsablePendingInstall,
  type EasyOrdersConnectionOverview,
  type EasyOrdersPendingInstall,
  type EasyOrdersProviderCleanup,
} from '../../database/repositories/easyorders-connections.repository';
import { CommerceOutcomeSyncsRepository } from '../../database/repositories/commerce-outcome-syncs.repository';
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
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import {
  decryptToken,
  encryptToken,
} from '../../../shared/utils/token-encryption.util';
import type {
  EasyOrdersConnectionHealth,
  EasyOrdersConnectionState,
  EasyOrdersConnectionStatusDto,
  EasyOrdersInstallStartedDto,
  SaveEasyOrdersOrderSettingsDto,
  SaveEasyOrdersWebhookSecretsDto,
  StartEasyOrdersInstallDto,
} from './dto/easyorders-connection.dto';
import {
  isCanonicalCurrency,
  normalizeCanonicalCurrency,
} from '../../../shared/commerce/canonical-order.rules';
import { PhoneService } from '../../../shared/services/phone.service';
import { EasyOrdersApiClient } from './easyorders-api.client';
import { readEasyOrdersApiKey } from './easyorders-credentials';
import {
  buildEasyOrdersInstallLink,
  buildEasyOrdersWebhookUrl,
} from './easyorders-install-link';
import {
  generateInstallToken,
  hashInstallToken,
  isWellFormedInstallToken,
} from '../../../shared/commerce/install-token';
import { installTokenHint } from './easyorders-install-token';
import {
  EASYORDERS_ROLE_REQUIRED,
  easyOrdersError,
  type EasyOrdersErrorCode,
} from './easyorders.errors';

/** How long the seller has to accept on the EasyOrders consent page. */
export const EASYORDERS_INSTALL_TTL_MS = 15 * 60 * 1000;

/**
 * A retried install registers the same address again, and whether one delete
 * call removes every copy is not documented, so it is repeated this often.
 */
const WEBHOOK_DELETE_PASSES = 3;

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
    private readonly phones: PhoneService,
    private readonly outcomeSyncs: CommerceOutcomeSyncsRepository,
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
      webhookTokenEncrypted: encryptToken(webhookToken, this.encryptionKey()),
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
    if (result.kind === 'store_mismatch')
      throw await this.reject(pending, 'EASYORDERS_RECONNECT_STORE_MISMATCH');

    this.logger.log(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-install-callback',
        outcome: 'success',
        orgId: result.orgId,
        integrationId: result.integrationId,
        pendingInstallId: pending.id,
        connectionHealth: probe === 'store_inactive' ? 'store_inactive' : 'ok',
        reconnected: result.reconnected,
      }),
    );
  }

  /**
   * Stops the source on Akeed's side (US-06-05): no new webhook is accepted,
   * nothing queued sends a message or writes to the store, and every stored
   * credential is wiped. History stays.
   *
   * Then Akeed asks EasyOrders to delete its two webhooks by address, with the
   * key it just gave up. That is best effort: the source is already stopped,
   * and the status says whether the merchant still has to delete them by hand.
   * The API key itself has no delete call; that row is always the merchant's.
   *
   * Not gated by the connect switch or the pilot list: turning the feature
   * off must never trap a merchant in a connection.
   */
  async disconnect(
    user: AuthenticatedUser,
  ): Promise<EasyOrdersConnectionStatusDto> {
    assertOrganizationWriteAllowed(user.role, EASYORDERS_ROLE_REQUIRED);
    const result = await this.connections.disconnect(user.orgId, user.userId);
    if (result.kind === 'not_connected')
      throw easyOrdersError('EASYORDERS_NOT_CONNECTED');

    if (result.kind === 'already_disconnected') {
      this.logger.log(
        buildBackendLog(EasyOrdersAuthService.name, {
          action: 'easyorders-disconnect',
          outcome: 'skipped',
          orgId: user.orgId,
          userId: user.userId,
          integrationId: result.integrationId,
        }),
      );
      return this.getStatus(user);
    }

    this.logger.log(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-disconnect',
        outcome: 'success',
        orgId: user.orgId,
        userId: user.userId,
        integrationId: result.integrationId,
        storeWasVerified: result.storeWasVerified,
        closedPendingSyncs: await this.closePendingSyncs(
          user.orgId,
          result.integrationId,
        ),
        providerCleanup: await this.removeProviderWebhooks(
          user.orgId,
          result.integrationId,
          result,
        ),
      }),
    );
    return this.getStatus(user);
  }

  /**
   * Deletes the two Akeed webhooks at EasyOrders and records how it went.
   * Never throws. A connection made before the URL token was kept has no
   * address to name, so its webhooks stay the merchant's to delete.
   */
  private async removeProviderWebhooks(
    orgId: string,
    integrationId: string,
    credentials: {
      apiKeyEncrypted: string | null;
      webhookTokenEncrypted: string | null;
    },
  ): Promise<EasyOrdersProviderCleanup> {
    let outcome: EasyOrdersProviderCleanup = 'manual';
    try {
      const apiKey = readEasyOrdersApiKey(credentials, this.encryptionKey());
      const webhookToken = this.readWebhookToken(
        credentials.webhookTokenEncrypted,
      );
      if (apiKey && webhookToken) {
        const { publicApiBaseUrl } = readEasyOrdersConfig(this.config);
        const removed = await Promise.all(
          (['orders', 'status'] as const).map((kind) =>
            this.removeWebhook(
              apiKey,
              buildEasyOrdersWebhookUrl(publicApiBaseUrl, kind, webhookToken),
            ),
          ),
        );
        if (removed.every(Boolean)) outcome = 'removed';
      }
      await this.connections.recordProviderCleanup(
        integrationId,
        orgId,
        outcome,
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(EasyOrdersAuthService.name, {
          action: 'easyorders-disconnect-remove-webhooks',
          outcome: 'failure',
          orgId,
          integrationId,
          ...normalizeError(error),
        }),
      );
      return 'manual';
    }
    return outcome;
  }

  /** True once EasyOrders holds no webhook for the address. */
  private async removeWebhook(
    apiKey: string,
    webhookUrl: string,
  ): Promise<boolean> {
    let removedOnce = false;
    for (let pass = 0; pass < WEBHOOK_DELETE_PASSES; pass += 1) {
      const result = await this.api.deleteWebhookByUrl(apiKey, webhookUrl);
      if (result === 'not_found') return true;
      if (result !== 'removed') return false;
      removedOnce = true;
    }
    return removedOnce;
  }

  private readWebhookToken(encrypted: string | null): string | null {
    if (!encrypted) return null;
    try {
      const token = decryptToken(encrypted, this.encryptionKey());
      return token !== encrypted && isWellFormedInstallToken(token)
        ? token
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Store updates still waiting would be refused when their job runs; closing
   * them now also covers a row whose job was lost. Best effort: the source is
   * already inactive, which is what stops the write.
   */
  private async closePendingSyncs(
    orgId: string,
    integrationId: string,
  ): Promise<number | null> {
    try {
      return await this.outcomeSyncs.failPendingForIntegration(
        orgId,
        integrationId,
        'integration_inactive',
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(EasyOrdersAuthService.name, {
          action: 'easyorders-disconnect-close-syncs',
          outcome: 'failure',
          orgId,
          integrationId,
          ...normalizeError(error),
        }),
      );
      return null;
    }
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
   * The fallback for the learned secrets (contract record section 7): the
   * seller copies both from their EasyOrders dashboard. They are encrypted
   * and write-only.
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

  /**
   * Forgets both webhook secrets, so each is learned again from the next
   * verified delivery. For a seller who recreated the webhooks in EasyOrders
   * and whose deliveries now carry secrets Akeed does not hold.
   */
  async resetWebhookSecrets(
    user: AuthenticatedUser,
  ): Promise<EasyOrdersConnectionStatusDto> {
    assertOrganizationWriteAllowed(user.role, EASYORDERS_ROLE_REQUIRED);
    const cleared = await this.connections.clearWebhookSecrets(user.orgId);
    if (!cleared) throw easyOrdersError('EASYORDERS_NOT_CONNECTED');

    this.logger.log(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-webhook-secrets-reset',
        outcome: 'success',
        orgId: user.orgId,
        userId: user.userId,
      }),
    );
    return this.getStatus(user);
  }

  /**
   * The store currency and the country local phone numbers are read in. The
   * order payload has neither (contract record section 4), so until both are
   * chosen every order is recorded as not eligible.
   */
  async saveOrderSettings(
    user: AuthenticatedUser,
    input: SaveEasyOrdersOrderSettingsDto,
  ): Promise<EasyOrdersConnectionStatusDto> {
    assertOrganizationWriteAllowed(user.role, EASYORDERS_ROLE_REQUIRED);
    const currency = normalizeCanonicalCurrency(input.currency);
    const phoneCountry = input.phoneCountry.toUpperCase();
    const fields = [
      ...(isCanonicalCurrency(currency) ? [] : ['currency']),
      ...(this.phones.callingCode(phoneCountry) === null
        ? ['phoneCountry']
        : []),
    ];
    if (fields.length > 0 || !isCanonicalCurrency(currency))
      throw easyOrdersError('EASYORDERS_ORDER_SETTINGS_INVALID', { fields });

    const saved = await this.connections.saveOrderSettings(user.orgId, {
      currency,
      phoneCountry,
    });
    if (!saved) throw easyOrdersError('EASYORDERS_NOT_CONNECTED');

    this.logger.log(
      buildBackendLog(EasyOrdersAuthService.name, {
        action: 'easyorders-order-settings-save',
        outcome: 'success',
        orgId: user.orgId,
        userId: user.userId,
        currency,
        phoneCountry,
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
    if (connection) {
      const details = {
        storeId: connection.storeId,
        storeVerified: connection.storeVerifiedAt !== null,
        health: toHealth(connection.health),
        webhookUrlHint: connection.webhookTokenHint,
        ordersSecretSet: connection.ordersWebhookSecretEncrypted !== null,
        statusSecretSet: connection.statusWebhookSecretEncrypted !== null,
        currency: connection.currency,
        phoneCountry: connection.phoneCountry,
        rejectedDeliveries: connection.rejectedDeliveries,
        connectedAt: connection.createdAt,
        disconnectedAt: connection.disconnectedAt,
        providerCleanup: toProviderCleanup(connection.providerCleanup),
      };
      if (!connection.disconnectedAt)
        return { ...base, state: 'connected', connection: details };
      // Before the switch and the pilot list: a disconnected merchant can
      // always see what happened. A reconnect attempt opened since shows as
      // pending, failed or expired; a disconnect retires every earlier one.
      const reconnect = pendingState(latestPending, new Date());
      return {
        ...base,
        ...reconnect,
        state: reconnect.state === 'ready' ? 'disconnected' : reconnect.state,
        connection: details,
      };
    }
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

function toProviderCleanup(
  value: string | null,
): EasyOrdersProviderCleanup | null {
  return value === 'removed' || value === 'manual' ? value : null;
}

function toHealth(value: string): EasyOrdersConnectionHealth {
  return value === 'store_inactive' || value === 'credentials_rejected'
    ? value
    : 'ok';
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
