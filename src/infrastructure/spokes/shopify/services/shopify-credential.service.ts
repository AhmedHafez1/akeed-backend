import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decryptToken } from '../../../../shared/utils/token-encryption.util';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import {
  ShopifyOfflineCredentialsRepository,
  type ShopifyCredentialState,
} from '../../../database/repositories/shopify-offline-credentials.repository';
import {
  ACCESS_TOKEN_RENEW_BEFORE_MS,
  ShopifyReauthRequiredError,
  ShopifyTokenRequestError,
} from './shopify-offline-token';
import { ShopifyTokenClient } from './shopify-token.client';

export interface ShopifyAccessToken {
  token: string;
  kind: 'legacy' | 'expiring';
  /** The credential version this token came from; see `renew`. */
  generation: number;
}

interface CredentialConnection {
  id: string;
  platformStoreUrl: string;
}

/**
 * Hands out a usable Admin API token for a store. Expiring tokens are read
 * from the database on every call, because the row a caller holds may be
 * older than the last refresh, and renewed under the shop's lock when they
 * are about to end.
 */
@Injectable()
export class ShopifyCredentialService {
  private readonly logger = new Logger(ShopifyCredentialService.name);

  constructor(
    private readonly credentials: ShopifyOfflineCredentialsRepository,
    private readonly tokenClient: ShopifyTokenClient,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async getAccessToken(
    connection: CredentialConnection,
    now: Date = new Date(),
  ): Promise<ShopifyAccessToken> {
    const state = await this.credentials.findState(connection.id);
    const usable = this.usableToken(state, connection, now);
    if (usable) return usable;
    return this.renew(connection, state?.generation ?? 0, false);
  }

  /**
   * Refreshes unless another worker already did: a caller passes the
   * generation of the token it holds, and gets the stored token back when
   * the generation has moved on. `force` refreshes a token that still looks
   * fresh, after Shopify rejected it.
   */
  async renew(
    connection: CredentialConnection,
    seenGeneration: number,
    force: boolean,
    now: Date = new Date(),
  ): Promise<ShopifyAccessToken> {
    const shop = connection.platformStoreUrl;
    try {
      return await this.credentials.withShopLock(shop, async (tx) => {
        const current = await this.credentials.findState(connection.id, tx);
        const usable = this.usableToken(current, connection, now);
        if (
          current &&
          current.credentialKind === 'expiring' &&
          current.generation !== seenGeneration &&
          current.accessToken
        )
          return this.decrypted(current, shop);
        if (usable && !force) return usable;
        if (!current?.refreshToken || current.credentialKind !== 'expiring')
          return this.decrypted(current, shop, connection);

        const pair = await this.tokenClient.refresh(
          shop,
          this.decrypt(current.refreshToken, shop),
        );
        await this.credentials.saveExpiringPair(
          tx,
          connection.id,
          pair,
          'refreshed',
        );
        this.logger.log(
          buildBackendLog(ShopifyCredentialService.name, {
            action: 'shopify-offline-token-refresh',
            outcome: 'success',
            integrationId: connection.id,
            shopDomain: shop,
          }),
        );
        return {
          token: pair.accessToken,
          kind: 'expiring' as const,
          generation: current.generation + 1,
        };
      });
    } catch (error) {
      if (error instanceof ShopifyTokenRequestError) {
        this.logger.warn(
          buildBackendLog(ShopifyCredentialService.name, {
            action: 'shopify-offline-token-refresh',
            outcome: 'failure',
            integrationId: connection.id,
            shopDomain: shop,
            errorCode: `refresh_${error.kind}`,
            httpStatus: error.httpStatus,
            providerError: error.providerError,
          }),
        );
        if (error.kind === 'rejected') {
          await this.markReauthRequired(connection, 'refresh_rejected');
          throw new ShopifyReauthRequiredError(shop, 'refresh_rejected');
        }
        await this.credentials
          .recordError(connection.id, `refresh_${error.kind}`)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /** Shopify refused the stored credential for good. */
  async markReauthRequired(
    connection: CredentialConnection,
    reason: string,
  ): Promise<void> {
    try {
      await this.credentials.markReauthRequired(connection.id, reason);
    } catch (error) {
      this.logger.error(
        buildBackendLog(ShopifyCredentialService.name, {
          action: 'shopify-offline-credential-reauth-mark',
          outcome: 'failure',
          integrationId: connection.id,
          shopDomain: connection.platformStoreUrl,
          errorCode: reason,
          ...normalizeError(error),
        }),
      );
      return;
    }
    this.logger.warn(
      buildBackendLog(ShopifyCredentialService.name, {
        action: 'shopify-offline-credential-reauth-mark',
        outcome: 'success',
        integrationId: connection.id,
        shopDomain: connection.platformStoreUrl,
        errorCode: reason,
      }),
    );
  }

  /** The stored token when it can be used as is, else undefined. */
  private usableToken(
    state: ShopifyCredentialState | undefined,
    connection: CredentialConnection,
    now: Date,
  ): ShopifyAccessToken | undefined {
    if (!state) return undefined;
    if (state.status === 'reauth_required')
      throw new ShopifyReauthRequiredError(
        connection.platformStoreUrl,
        'reauth_required',
      );
    if (state.credentialKind === 'legacy')
      return this.decrypted(state, connection.platformStoreUrl);
    const expiresAt = state.accessTokenExpiresAt
      ? Date.parse(state.accessTokenExpiresAt)
      : NaN;
    if (
      state.accessToken &&
      Number.isFinite(expiresAt) &&
      expiresAt - now.getTime() > ACCESS_TOKEN_RENEW_BEFORE_MS
    )
      return this.decrypted(state, connection.platformStoreUrl);
    return undefined;
  }

  private decrypted(
    state: ShopifyCredentialState | undefined,
    shop: string,
    connection?: CredentialConnection,
  ): ShopifyAccessToken {
    if (!state?.accessToken) {
      this.logger.error(
        buildBackendLog(ShopifyCredentialService.name, {
          action: 'shopify-access-token-resolve',
          outcome: 'failure',
          integrationId: connection?.id ?? state?.integrationId,
          shopDomain: shop,
          errorCode: 'missing_access_token',
        }),
      );
      throw new Error(`Missing token for domain: ${shop}`);
    }
    return {
      token: this.decrypt(state.accessToken, shop),
      kind: state.credentialKind,
      generation: state.generation,
    };
  }

  private decrypt(payload: string, shop: string): string {
    const key = this.config.get<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY');
    if (!key) throw new Error('Missing SHOPIFY_TOKEN_ENCRYPTION_KEY');
    try {
      return decryptToken(payload, key);
    } catch {
      throw new Error(
        `Unable to decrypt the stored Shopify token for ${shop}. Reconnect the store using the current SHOPIFY_TOKEN_ENCRYPTION_KEY.`,
      );
    }
  }
}
