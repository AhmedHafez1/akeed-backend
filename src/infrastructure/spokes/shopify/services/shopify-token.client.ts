import { Inject, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom, timeout } from 'rxjs';
import {
  classifyTokenFailure,
  EXPIRING_FLAG,
  ID_TOKEN_TYPE,
  OFFLINE_ACCESS_TOKEN_TYPE,
  parseExpiringTokenResponse,
  REFRESH_TOKEN_GRANT,
  type ShopifyOfflineTokenPair,
  ShopifyTokenRequestError,
  TOKEN_EXCHANGE_GRANT,
} from './shopify-offline-token';

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Calls Shopify's token endpoint for every grant. Each call returns a fresh
 * expiring pair and retires the store's previous one, so callers run it under
 * the store's credential lock. No call is retried here.
 */
@Injectable()
export class ShopifyTokenClient {
  constructor(
    @Inject(HttpService) private readonly http: HttpService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** App Bridge session token → expiring offline pair. */
  exchangeIdToken(
    shop: string,
    sessionToken: string,
  ): Promise<ShopifyOfflineTokenPair> {
    return this.request(shop, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: sessionToken,
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: OFFLINE_ACCESS_TOKEN_TYPE,
      expiring: EXPIRING_FLAG,
    });
  }

  /** OAuth authorization code → expiring offline pair. */
  exchangeCode(shop: string, code: string): Promise<ShopifyOfflineTokenPair> {
    return this.request(shop, { code, expiring: EXPIRING_FLAG });
  }

  /** Stored refresh token → the next pair. The refresh token rotates. */
  refresh(
    shop: string,
    refreshToken: string,
  ): Promise<ShopifyOfflineTokenPair> {
    return this.request(shop, {
      grant_type: REFRESH_TOKEN_GRANT,
      refresh_token: refreshToken,
    });
  }

  /**
   * A non-expiring token → an expiring pair. Success invalidates the old
   * token at once; repeating the call with it within seven days returns the
   * same pair, which is how an unsaved answer is recovered.
   */
  migrateLegacy(
    shop: string,
    legacyToken: string,
  ): Promise<ShopifyOfflineTokenPair> {
    return this.request(shop, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: legacyToken,
      subject_token_type: OFFLINE_ACCESS_TOKEN_TYPE,
      requested_token_type: OFFLINE_ACCESS_TOKEN_TYPE,
      expiring: EXPIRING_FLAG,
    });
  }

  private async request(
    shop: string,
    grant: Record<string, string>,
  ): Promise<ShopifyOfflineTokenPair> {
    let data: unknown;
    try {
      ({ data } = await firstValueFrom(
        this.http
          .post<unknown>(
            `https://${shop}/admin/oauth/access_token`,
            {
              client_id: this.config.getOrThrow<string>('SHOPIFY_API_KEY'),
              client_secret:
                this.config.getOrThrow<string>('SHOPIFY_API_SECRET'),
              ...grant,
            },
            {
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              timeout: TOKEN_REQUEST_TIMEOUT_MS,
            },
          )
          .pipe(timeout(TOKEN_REQUEST_TIMEOUT_MS)),
      ));
    } catch (error) {
      if (error instanceof ShopifyTokenRequestError) throw error;
      throw isAxiosError(error)
        ? classifyTokenFailure(error.response?.status, error.response?.data)
        : classifyTokenFailure(undefined, undefined);
    }
    return parseExpiringTokenResponse(data);
  }
}
