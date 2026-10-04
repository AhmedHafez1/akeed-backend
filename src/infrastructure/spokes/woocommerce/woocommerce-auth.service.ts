import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WooCommerceConnectionsRepository,
  isUsablePendingInstall,
  type WooCommerceConnectionOverview,
  type WooCommercePendingInstall,
} from '../../database/repositories/woocommerce-connections.repository';
import type { AuthenticatedUser } from '../../../modules/auth/guards/dual-auth.guard';
import {
  assertOrganizationWriteAllowed,
  canWriteOrganization,
} from '../../../modules/auth/organization-role';
import {
  isWooCommercePilotOrganization,
  readWooCommerceConfig,
  type WooCommerceConfig,
} from '../../../shared/config/woocommerce.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import type {
  StartWooCommerceInstallDto,
  WooCommerceConnectionHealth,
  WooCommerceConnectionState,
  WooCommerceConnectionStatusDto,
  WooCommerceInstallStartedDto,
} from './dto/woocommerce-connection.dto';
import {
  WooCommerceApiClient,
  WOOCOMMERCE_WEBHOOKS_PER_PAGE,
  type WooCommerceCallFailure,
  type WooCommerceCredentials,
} from './woocommerce-api.client';
import {
  buildWooCommerceAuthorizeLink,
  buildWooCommerceWebhookDeliveryBase,
  buildWooCommerceWebhookDeliveryUrl,
} from './woocommerce-install-link';
import {
  generateInstallReference,
  generateInstallToken,
  generateWebhookSecret,
  hashInstallToken,
  isWellFormedInstallToken,
  matchesInstallReference,
} from './woocommerce-install-token';
import {
  canonicalizeWooCommerceStoreUrl,
  wooCommerceStoreHost,
} from './woocommerce-store-url';
import {
  WOOCOMMERCE_ROLE_REQUIRED,
  wooCommerceError,
  type WooCommerceErrorCode,
} from './woocommerce.errors';

/** How long the merchant has to approve on the store's authorize page. */
export const WOOCOMMERCE_INSTALL_TTL_MS = 15 * 60 * 1000;

/**
 * The callback does all its store calls inside one request from the store,
 * and how long the store waits is unknown (finding 8.6).
 */
export const WOOCOMMERCE_CALLBACK_BUDGET_MS = 30_000;

/** The store's webhooks are read at most this many pages deep. */
export const WOOCOMMERCE_WEBHOOK_LIST_MAX_PAGES = 10;

export const WOOCOMMERCE_REQUIRED_KEY_PERMISSIONS = 'read_write';

export const WOOCOMMERCE_ORDER_WEBHOOKS = [
  { name: 'Akeed order created', topic: 'order.created' },
  { name: 'Akeed order updated', topic: 'order.updated' },
] as const;

const KEY_MAX_LENGTH = 512;
const VERSION_MAX_LENGTH = 32;
/** Printable ASCII without spaces: a key, never free text. */
const OPAQUE_VALUE_PATTERN = /^[\x21-\x7E]+$/;
const PRINTABLE_PATTERN = /^[\x20-\x7E]+$/;

interface InstallCallbackBody {
  consumerKey: string;
  consumerSecret: string;
  userId: unknown;
  keyPermissions: unknown;
}

function isBoundedKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= KEY_MAX_LENGTH &&
    OPAQUE_VALUE_PATTERN.test(value)
  );
}

/**
 * Reads the documented fields and ignores anything else. Nothing in the body
 * is trusted beyond its shape: the keys are proven against the store URL the
 * install context holds, and the body names no store at all.
 */
export function parseInstallCallbackBody(
  body: unknown,
): InstallCallbackBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const {
    consumer_key: consumerKey,
    consumer_secret: consumerSecret,
    user_id: userId,
    key_permissions: keyPermissions,
  } = body as Record<string, unknown>;
  if (!isBoundedKey(consumerKey) || !isBoundedKey(consumerSecret)) return null;
  return { consumerKey, consumerSecret, userId, keyPermissions };
}

/** What a refused callback is answered with, and whether it counts. */
interface Refusal {
  code: WooCommerceErrorCode;
  countAttempt: boolean;
}

type InstallOutcome =
  | { kind: 'connected'; orgId: string; integrationId: string }
  | ({ kind: 'refused' } & Refusal);

function refused(
  code: WooCommerceErrorCode,
  countAttempt = true,
): InstallOutcome {
  return { kind: 'refused', code, countAttempt };
}

/** The codes a failed store call maps to, whichever call it was. */
const STORE_FAILURE_CODES: Partial<
  Record<WooCommerceCallFailure, WooCommerceErrorCode>
> = {
  address_not_public: 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC',
  redirects: 'WOOCOMMERCE_STORE_REDIRECTS',
  tls_failed: 'WOOCOMMERCE_STORE_TLS_FAILED',
  credentials_rejected: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
  permission_denied: 'WOOCOMMERCE_PERMISSION_DENIED',
  budget_exceeded: 'WOOCOMMERCE_PROVIDER_UNAVAILABLE',
};

/** A failure while reaching the REST API itself: the probe and the key proof. */
function restFailureCode(reason: WooCommerceCallFailure): WooCommerceErrorCode {
  return (
    STORE_FAILURE_CODES[reason] ??
    (reason === 'rest_not_found'
      ? 'WOOCOMMERCE_REST_NOT_FOUND'
      : 'WOOCOMMERCE_REST_UNREACHABLE')
  );
}

/** A failure while replacing the webhooks, after the keys were proven. */
function webhookFailureCode(
  reason: WooCommerceCallFailure,
): WooCommerceErrorCode {
  return STORE_FAILURE_CODES[reason] ?? 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED';
}

/**
 * The WooCommerce install (US-07-02), as the US-07-01 contract record defines
 * it: an owner or admin of a source-less pilot organization names a store and
 * opens a single-use context, approves in the store, and the store posts keys
 * that are proven against that store before anything is stored.
 */
@Injectable()
export class WooCommerceAuthService {
  private readonly logger = new Logger(WooCommerceAuthService.name);

  constructor(
    private readonly connections: WooCommerceConnectionsRepository,
    private readonly api: WooCommerceApiClient,
    private readonly config: ConfigService,
  ) {}

  async startInstall(
    user: AuthenticatedUser,
    input: StartWooCommerceInstallDto,
  ): Promise<WooCommerceInstallStartedDto> {
    const settings = this.assertCanConnect(user);

    const store = canonicalizeWooCommerceStoreUrl(input.storeUrl);
    if (!store.ok)
      throw this.refuseStart(
        user,
        store.reason === 'https_required'
          ? 'WOOCOMMERCE_STORE_HTTPS_REQUIRED'
          : 'WOOCOMMERCE_STORE_URL_INVALID',
      );
    const storeHost = wooCommerceStoreHost(store.url);

    // Before any request leaves: an organization that cannot connect must
    // not be able to make Akeed call an address of its choosing.
    const overview = await this.connections.getOverview(user.orgId);
    if (overview.sourcePlatforms.length > 0)
      throw this.refuseStart(user, 'WOOCOMMERCE_SOURCE_EXISTS', storeHost);

    // Outside any transaction: a slow store must not hold row locks.
    const probe = await this.api.probeRestApi(store.url);
    if (probe.kind === 'failed')
      throw this.refuseStart(user, restFailureCode(probe.reason), storeHost);

    const callbackToken = generateInstallToken();
    const installReference = generateInstallReference();
    const result = await this.connections.createPendingInstall({
      orgId: user.orgId,
      createdBy: user.userId,
      storeUrl: store.url,
      callbackTokenHash: hashInstallToken(callbackToken),
      installReference,
      expiresAt: new Date(
        Date.now() + WOOCOMMERCE_INSTALL_TTL_MS,
      ).toISOString(),
    });
    if (result.kind === 'source_exists')
      throw this.refuseStart(user, 'WOOCOMMERCE_SOURCE_EXISTS', storeHost);

    this.logger.log(
      buildBackendLog(WooCommerceAuthService.name, {
        action: 'woocommerce-install-start',
        outcome: 'success',
        orgId: user.orgId,
        userId: user.userId,
        pendingInstallId: result.pending.id,
        storeHost,
      }),
    );
    return {
      authorizeUrl: buildWooCommerceAuthorizeLink({
        storeUrl: store.url,
        publicApiBaseUrl: settings.publicApiBaseUrl,
        appBaseUrl: settings.appBaseUrl,
        callbackToken,
        installReference,
        locale: input.locale,
      }),
      storeUrl: store.url,
      expiresAt: result.pending.expiresAt,
    };
  }

  /**
   * The public callback. The path token is the only thing that binds the
   * request to a tenant and to a store, so every way it can be wrong gets the
   * same answer, and nothing in the request is echoed back or logged.
   */
  async handleCallback(token: string, body: unknown): Promise<void> {
    const settings = readWooCommerceConfig(this.config);
    if (!settings.enabled)
      throw wooCommerceError('WOOCOMMERCE_CONNECT_UNAVAILABLE');

    const pending = isWellFormedInstallToken(token)
      ? await this.connections.findPendingByCallbackTokenHash(
          hashInstallToken(token),
        )
      : undefined;
    if (
      !pending ||
      !isUsablePendingInstall(pending, new Date()) ||
      !isWooCommercePilotOrganization(settings, pending.orgId) ||
      // Last: a second callback while one is running is refused here too.
      !(await this.connections.claimPendingInstall(pending.id))
    ) {
      this.logger.warn(
        buildBackendLog(WooCommerceAuthService.name, {
          action: 'woocommerce-install-callback',
          outcome: 'failure',
          orgId: pending?.orgId,
          pendingInstallId: pending?.id,
          errorCode: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
        }),
      );
      throw wooCommerceError('WOOCOMMERCE_INSTALL_CONTEXT_INVALID');
    }

    let outcome: InstallOutcome;
    try {
      outcome = await this.finishInstall(settings, pending, body);
    } catch (error) {
      await this.releaseAfterFault(pending, error);
      throw error;
    }
    if (outcome.kind === 'refused') throw await this.reject(pending, outcome);

    this.logger.log(
      buildBackendLog(WooCommerceAuthService.name, {
        action: 'woocommerce-install-callback',
        outcome: 'success',
        orgId: outcome.orgId,
        integrationId: outcome.integrationId,
        pendingInstallId: pending.id,
        storeHost: wooCommerceStoreHost(pending.storeUrl),
      }),
    );
  }

  /** Any member may read the status; it never contains a credential. */
  async getStatus(
    user: AuthenticatedUser,
  ): Promise<WooCommerceConnectionStatusDto> {
    const settings = readWooCommerceConfig(this.config);
    const overview = await this.connections.getOverview(user.orgId);
    return this.toStatus(user, settings, overview);
  }

  /**
   * Steps 2 to 5 of the callback acceptance (contract record section 1).
   * Nothing is stored before the last step, and every store call is made
   * against the URL the install context holds.
   */
  private async finishInstall(
    settings: WooCommerceConfig,
    pending: WooCommercePendingInstall,
    body: unknown,
  ): Promise<InstallOutcome> {
    const parsed = parseInstallCallbackBody(body);
    if (
      !parsed ||
      !matchesInstallReference(parsed.userId, pending.installReference)
    )
      return refused('WOOCOMMERCE_CALLBACK_INVALID');
    if (parsed.keyPermissions !== WOOCOMMERCE_REQUIRED_KEY_PERMISSIONS)
      return refused('WOOCOMMERCE_PERMISSION_DENIED');
    const credentials: WooCommerceCredentials = {
      consumerKey: parsed.consumerKey,
      consumerSecret: parsed.consumerSecret,
    };
    const { storeUrl } = pending;

    // Before any store call: the webhook step below deletes Akeed's webhooks
    // at the store, and those would be the other organization's.
    if (
      await this.connections.isStoreVerifiedForAnotherOrganization(
        storeUrl,
        pending.orgId,
      )
    )
      return refused('WOOCOMMERCE_STORE_UNAVAILABLE');

    const budget = AbortSignal.timeout(WOOCOMMERCE_CALLBACK_BUDGET_MS);

    // Outside any transaction: a slow store must not hold row locks.
    const proof = await this.api.readSystemStatus(
      storeUrl,
      credentials,
      budget,
    );
    if (proof.kind === 'failed') return refused(restFailureCode(proof.reason));
    // The store has to call itself by the address the merchant entered. Its
    // own value is compared and then dropped: never stored, logged or shown.
    const reported = canonicalizeWooCommerceStoreUrl(proof.homeUrl);
    if (!reported.ok || reported.url !== storeUrl)
      return refused('WOOCOMMERCE_STORE_URL_MISMATCH');

    // A newer install may have retired this one while the store was being
    // asked; its webhooks must not be deleted by this run.
    const current = await this.connections.findPendingById(pending.id);
    if (!current || !isUsablePendingInstall(current, new Date()))
      return refused('WOOCOMMERCE_INSTALL_CONTEXT_INVALID', false);

    // The delivery URL token is generated here, not when the install starts:
    // only its hash is ever stored, and this is the request that has to put
    // the token itself into the URL. The hash goes in first, because the
    // store pings the URL as soon as a webhook is saved.
    const webhookToken = generateInstallToken();
    const webhookTokenHash = hashInstallToken(webhookToken);
    await this.connections.setPendingWebhookTokenHash(
      pending.id,
      webhookTokenHash,
    );

    const webhookSecret = generateWebhookSecret();
    const webhooks = await this.replaceWebhooks(
      storeUrl,
      credentials,
      {
        deliveryBase: buildWooCommerceWebhookDeliveryBase(
          settings.publicApiBaseUrl,
        ),
        deliveryUrl: buildWooCommerceWebhookDeliveryUrl(
          settings.publicApiBaseUrl,
          webhookToken,
        ),
        secret: webhookSecret,
      },
      budget,
    );
    if (webhooks.kind === 'failed')
      return refused(webhookFailureCode(webhooks.reason));

    const key = this.encryptionKey();
    let result: Awaited<
      ReturnType<WooCommerceConnectionsRepository['connect']>
    >;
    try {
      result = await this.connections.connect({
        pendingInstallId: pending.id,
        webhookTokenHash,
        consumerKeyEncrypted: encryptToken(credentials.consumerKey, key),
        consumerSecretEncrypted: encryptToken(credentials.consumerSecret, key),
        webhookSecretEncrypted: encryptToken(webhookSecret, key),
        orderCreatedWebhookId: webhooks.ids[0],
        orderUpdatedWebhookId: webhooks.ids[1],
        wooVersion: toStoredVersion(proof.version),
      });
    } catch (error) {
      await this.deleteWebhooks(storeUrl, credentials, webhooks.ids);
      throw error;
    }
    if (result.kind === 'connected') return result;

    // Nothing was stored, so nothing may be left delivering to Akeed.
    await this.deleteWebhooks(storeUrl, credentials, webhooks.ids);
    if (result.kind === 'context_invalid')
      return refused('WOOCOMMERCE_INSTALL_CONTEXT_INVALID', false);
    return refused(
      result.kind === 'source_exists'
        ? 'WOOCOMMERCE_SOURCE_EXISTS'
        : 'WOOCOMMERCE_STORE_UNAVAILABLE',
    );
  }

  /**
   * Deletes every webhook at the store that delivers to Akeed, then creates
   * the two for this install. That is what makes a retry replace webhooks
   * instead of adding to them. If the second cannot be created the first is
   * removed again, so the store is never left with half of them.
   */
  private async replaceWebhooks(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    target: { deliveryBase: string; deliveryUrl: string; secret: string },
    budget: AbortSignal,
  ): Promise<
    | { kind: 'ok'; ids: [number, number] }
    | { kind: 'failed'; reason: WooCommerceCallFailure }
  > {
    const stale: number[] = [];
    for (let page = 1; ; page++) {
      // More pages than this cannot be read through, so a leftover webhook
      // could survive; refusing is the only way to promise it does not.
      if (page > WOOCOMMERCE_WEBHOOK_LIST_MAX_PAGES)
        return { kind: 'failed', reason: 'unreachable' };
      const listed = await this.api.listWebhooks(
        storeUrl,
        credentials,
        page,
        budget,
      );
      if (listed.kind === 'failed') return listed;
      for (const webhook of listed.webhooks)
        if (webhook.deliveryUrl.startsWith(target.deliveryBase))
          stale.push(webhook.id);
      const isLastPage =
        listed.totalPages === null
          ? listed.webhooks.length < WOOCOMMERCE_WEBHOOKS_PER_PAGE
          : page >= listed.totalPages;
      if (isLastPage) break;
    }
    for (const webhookId of stale) {
      const deleted = await this.api.deleteWebhook(
        storeUrl,
        credentials,
        webhookId,
        budget,
      );
      if (deleted.kind === 'failed') return deleted;
    }

    const created: number[] = [];
    for (const webhook of WOOCOMMERCE_ORDER_WEBHOOKS) {
      const result = await this.api.createWebhook(
        storeUrl,
        credentials,
        {
          name: webhook.name,
          topic: webhook.topic,
          deliveryUrl: target.deliveryUrl,
          secret: target.secret,
        },
        budget,
      );
      if (result.kind === 'failed') {
        await this.deleteWebhooks(storeUrl, credentials, created);
        return result;
      }
      created.push(result.id);
    }
    return { kind: 'ok', ids: [created[0], created[1]] };
  }

  /**
   * Best effort, and without the callback's budget: it runs exactly when
   * something already went wrong, possibly because the budget ran out.
   */
  private async deleteWebhooks(
    storeUrl: string,
    credentials: WooCommerceCredentials,
    webhookIds: readonly number[],
  ): Promise<void> {
    for (const webhookId of webhookIds) {
      const deleted = await this.api.deleteWebhook(
        storeUrl,
        credentials,
        webhookId,
      );
      if (deleted.kind === 'failed')
        this.logger.warn(
          buildBackendLog(WooCommerceAuthService.name, {
            action: 'woocommerce-install-webhook-cleanup',
            outcome: 'failure',
            storeHost: wooCommerceStoreHost(storeUrl),
            reason: deleted.reason,
          }),
        );
    }
  }

  private assertCanConnect(user: AuthenticatedUser): WooCommerceConfig {
    // An embedded Shopify session always has a Shopify source already.
    if (user.source !== 'supabase')
      throw wooCommerceError('WOOCOMMERCE_SESSION_REQUIRED');
    assertOrganizationWriteAllowed(user.role, WOOCOMMERCE_ROLE_REQUIRED);
    const settings = readWooCommerceConfig(this.config);
    if (!settings.enabled)
      throw wooCommerceError('WOOCOMMERCE_CONNECT_UNAVAILABLE');
    if (!isWooCommercePilotOrganization(settings, user.orgId))
      throw wooCommerceError('WOOCOMMERCE_PILOT_REQUIRED');
    return settings;
  }

  private refuseStart(
    user: AuthenticatedUser,
    code: WooCommerceErrorCode,
    storeHost?: string,
  ): HttpException {
    this.logger.warn(
      buildBackendLog(WooCommerceAuthService.name, {
        action: 'woocommerce-install-start',
        outcome: 'failure',
        orgId: user.orgId,
        userId: user.userId,
        storeHost,
        errorCode: code,
      }),
    );
    return wooCommerceError(code);
  }

  private async reject(
    pending: WooCommercePendingInstall,
    refusal: Refusal,
  ): Promise<HttpException> {
    if (refusal.countAttempt)
      await this.connections.recordFailedAttempt(pending.id, refusal.code);
    else await this.connections.releasePendingInstall(pending.id);
    this.logger.warn(
      buildBackendLog(WooCommerceAuthService.name, {
        action: 'woocommerce-install-callback',
        outcome: 'failure',
        orgId: pending.orgId,
        pendingInstallId: pending.id,
        storeHost: wooCommerceStoreHost(pending.storeUrl),
        errorCode: refusal.code,
      }),
    );
    return wooCommerceError(refusal.code);
  }

  /** An unexpected fault must not keep the link busy until the claim lapses. */
  private async releaseAfterFault(
    pending: WooCommercePendingInstall,
    fault: unknown,
  ): Promise<void> {
    this.logger.error(
      buildBackendLog(WooCommerceAuthService.name, {
        action: 'woocommerce-install-callback',
        outcome: 'failure',
        orgId: pending.orgId,
        pendingInstallId: pending.id,
        storeHost: wooCommerceStoreHost(pending.storeUrl),
        ...normalizeError(fault),
      }),
    );
    try {
      await this.connections.releasePendingInstall(pending.id);
    } catch (error) {
      this.logger.error(
        buildBackendLog(WooCommerceAuthService.name, {
          action: 'woocommerce-install-claim-release',
          outcome: 'failure',
          orgId: pending.orgId,
          pendingInstallId: pending.id,
          ...normalizeError(error),
        }),
      );
    }
  }

  private toStatus(
    user: AuthenticatedUser,
    settings: WooCommerceConfig,
    overview: WooCommerceConnectionOverview,
  ): WooCommerceConnectionStatusDto {
    const { connection, latestPending } = overview;
    const base = {
      canManage: user.source === 'supabase' && canWriteOrganization(user.role),
      organizationName: overview.organizationName,
      storeUrl: null,
      expiresAt: null,
      lastErrorCode: null,
      connection: null,
    };
    // Before the switch and the pilot list: a connected merchant can always
    // see the connection.
    if (connection)
      return {
        ...base,
        state: 'connected',
        storeUrl: connection.storeUrl,
        connection: {
          storeUrl: connection.storeUrl,
          health: toHealth(connection.health),
          connectedAt: connection.connectedAt,
        },
      };
    if (!settings.enabled) return { ...base, state: 'unavailable' };
    if (overview.sourcePlatforms.length > 0)
      return { ...base, state: 'source_exists' };
    if (!isWooCommercePilotOrganization(settings, user.orgId))
      return { ...base, state: 'pilot_required' };
    return { ...base, ...pendingState(latestPending, new Date()) };
  }

  private encryptionKey(): string {
    return this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY');
  }
}

function toHealth(value: string): WooCommerceConnectionHealth {
  return value === 'credentials_rejected' || value === 'permission_denied'
    ? value
    : 'ok';
}

/** Kept for support only, and only when it looks like a version. */
function toStoredVersion(version: string | null): string | null {
  return version !== null &&
    version.length > 0 &&
    version.length <= VERSION_MAX_LENGTH &&
    PRINTABLE_PATTERN.test(version)
    ? version
    : null;
}

/**
 * What the organization's latest install context says. A refused callback
 * shows as `failed` even while the link could still be retried: the merchant
 * saw the store finish and needs to know why nothing was connected.
 */
function pendingState(
  pending: WooCommercePendingInstall | undefined,
  now: Date,
): Pick<
  WooCommerceConnectionStatusDto,
  'state' | 'storeUrl' | 'expiresAt' | 'lastErrorCode'
> {
  const none = { storeUrl: null, expiresAt: null, lastErrorCode: null };
  if (!pending || pending.consumedAt || pending.supersededAt)
    return { state: 'ready' satisfies WooCommerceConnectionState, ...none };
  const { storeUrl } = pending;
  if (pending.lastErrorCode)
    return {
      state: 'failed',
      storeUrl,
      expiresAt: null,
      lastErrorCode: pending.lastErrorCode,
    };
  if (!isUsablePendingInstall(pending, now))
    return { state: 'expired', ...none, storeUrl };
  return {
    state: 'pending',
    storeUrl,
    expiresAt: pending.expiresAt,
    lastErrorCode: null,
  };
}
