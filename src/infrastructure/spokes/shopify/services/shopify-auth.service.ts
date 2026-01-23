import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class ShopifyAuthService {
  private readonly logger = new Logger(ShopifyAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly integrationsRepo: IntegrationsRepository,
  ) {}

  buildAuthorizationUrl(shop: string, orgId: string): string {
    const clientId = this.config.get<string>('SHOPIFY_CLIENT_ID');
    const redirectUri =
      this.config.get<string>('SHOPIFY_REDIRECT_URI') ||
      `http://localhost:${this.config.get('PORT') || 3000}/auth/shopify/callback`;

    if (!clientId) {
      throw new Error('SHOPIFY_CLIENT_ID is not configured');
    }

    const scopes = ['read_orders', 'write_orders'].join(',');
    // Encode state to carry orgId through OAuth
    const stateObj = { orgId };
    const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

    const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('scope', scopes);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);

    return authorizeUrl.toString();
  }

  validateQueryHmac(query: Record<string, any>): boolean {
    const secret = this.config.get<string>('SHOPIFY_API_SECRET');
    if (!secret) {
      this.logger.error('SHOPIFY_API_SECRET is not configured');
      return false;
    }

    const providedHmac = query['hmac'] as string;
    if (!providedHmac) {
      this.logger.warn('Missing hmac in callback query');
      return false;
    }

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (key === 'hmac' || key === 'signature') continue;
      // Shopify sends arrays sometimes; normalize to comma-separated as common practice
      const v = Array.isArray(value) ? value.join(',') : String(value ?? '');
      params[key] = v;
    }

    const message = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    const digest = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    // timing-safe compare
    const a = Buffer.from(digest, 'hex');
    const b = Buffer.from(providedHmac, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async exchangeCodeForToken(
    shop: string,
    code: string,
  ): Promise<{ accessToken: string; expiresIn?: number }> {
    const clientId = this.config.get<string>('SHOPIFY_CLIENT_ID');
    const clientSecret = this.config.get<string>('SHOPIFY_API_SECRET');

    if (!clientId || !clientSecret) {
      throw new Error(
        'SHOPIFY_CLIENT_ID/SHOPIFY_API_SECRET are not configured',
      );
    }

    const url = `https://${shop}/admin/oauth/access_token`;

    interface AccessTokenResponse {
      access_token: string;
      scope?: string;
      expires_in?: number;
    }

    const response = await axios.post<AccessTokenResponse>(url, {
      client_id: clientId,
      client_secret: clientSecret,
      code,
    });

    const accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in;
    if (!accessToken) {
      this.logger.error(`No access_token in Shopify response for ${shop}`);
      throw new Error('Failed to retrieve Shopify access token');
    }
    return { accessToken, expiresIn };
  }

  async saveIntegration(
    orgId: string,
    shopDomain: string,
    accessToken: string,
    expiresIn?: number,
  ) {
    let expiresAt: string | undefined;
    if (typeof expiresIn === 'number' && expiresIn > 0) {
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    }
    return this.integrationsRepo.upsertShopifyIntegration(
      orgId,
      shopDomain,
      'shopify',
      accessToken,
      expiresAt,
    );
  }

  async refreshAccessTokenIfNeeded(shopDomain: string): Promise<string | null> {
    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );
    if (!integration) {
      this.logger.warn(`No Shopify integration found for domain ${shopDomain}`);
      return null;
    }

    const currentToken = integration.accessToken as string;
    const expiresAtStr = integration.expiresAt as string;
    if (!expiresAtStr || !currentToken) {
      // No expiry tracking or no token; nothing to refresh
      return currentToken ?? null;
    }

    const expiresAtMs = new Date(expiresAtStr).getTime();
    const timeLeftMs = expiresAtMs - Date.now();
    const thresholdMs = 5 * 60 * 1000; // 5 minutes

    if (timeLeftMs > thresholdMs) {
      return currentToken; // Still valid enough
    }

    const clientId = this.config.get<string>('SHOPIFY_CLIENT_ID');
    const clientSecret = this.config.get<string>('SHOPIFY_API_SECRET');
    if (!clientId || !clientSecret) {
      this.logger.error(
        'SHOPIFY_CLIENT_ID/SHOPIFY_API_SECRET are not configured',
      );
      return currentToken;
    }

    const url = `https://${shopDomain}/admin/oauth/access_token`;
    interface ClientCredentialsResponse {
      access_token: string;
      expires_in?: number;
      scope?: string;
    }

    try {
      const response = await axios.post<ClientCredentialsResponse>(url, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      });
      const newToken = response.data.access_token;
      const expiresIn = response.data.expires_in;
      if (!newToken) {
        this.logger.error('Failed to refresh Shopify access token');
        return currentToken;
      }
      const newExpiresAt =
        typeof expiresIn === 'number' && expiresIn > 0
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : undefined;
      await this.integrationsRepo.upsertShopifyIntegration(
        integration.orgId,
        shopDomain,
        'shopify',
        newToken,
        newExpiresAt,
      );
      this.logger.log(`Refreshed Shopify token for ${shopDomain}`);
      return newToken;
    } catch (err) {
      this.logger.error('Error refreshing Shopify token', err as any);
      return currentToken;
    }
  }
}
