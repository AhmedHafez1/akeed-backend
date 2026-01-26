import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { OrganizationsRepository } from '../../../database/repositories/organizations.repository';
import {
  generateNonce,
  validateShop,
  verifyShopifyHmac,
} from '../shopify.utils';

@Injectable()
export class ShopifyAuthService {
  private readonly logger = new Logger(ShopifyAuthService.name);
  // In-memory state store (replace with Redis in production)
  private readonly stateStore = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly organizationsRepo: OrganizationsRepository,
  ) {}

  async isInstalled(shop: string): Promise<boolean> {
    return Boolean(
      await this.integrationsRepo.findByPlatformDomain(shop, 'shopify'),
    );
  }

  async install(shop: string): Promise<string> {
    if (!validateShop(shop)) {
      throw new BadRequestException('Invalid shop parameter');
    }

    this.logger.log(`Installing Shopify app for shop: ${shop}`);

    const apiKey = this.configService.getOrThrow<string>('SHOPIFY_API_KEY');
    const scopes = this.configService.getOrThrow<string>('SHOPIFY_SCOPES');
    const appUrl = this.configService.getOrThrow<string>('APP_URL');
    const redirectUri = `${appUrl}/auth/shopify/callback`;
    const state = generateNonce();

    // Store state with timestamp for expiration (10 mins)
    this.stateStore.set(state, Date.now());

    // Clean up old states roughly occasionally
    if (this.stateStore.size > 100) {
      this.cleanupStates();
    }

    const queryParams = new URLSearchParams({
      client_id: apiKey,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
    });

    const authUrl = `https://${shop}/admin/oauth/authorize?${queryParams.toString()}`;

    this.logger.log(`Shopify app installation URL: ${authUrl}`);

    return authUrl;
  }

  async callback(query: Record<string, string>): Promise<string> {
    const { shop, code, state, hmac } = query;

    if (!shop || !code || !state || !hmac) {
      throw new BadRequestException('Missing required parameters');
    }

    if (!validateShop(shop)) {
      throw new BadRequestException('Invalid shop parameter');
    }

    this.logger.log(`Shopify app callback for shop: ${shop}`);

    this.verifyHmac(query);
    this.verifyState(state);

    // Exchange code for access token
    const accessToken = await this.exchangeCodeForToken(shop, code);

    // Persist integration
    await this.handlePersistence(shop, accessToken);

    // Register Webhooks
    await this.registerWebhooks(shop, accessToken);

    // Redirect to app
    // TODO: Determine the correct post-install redirect.
    // Usually it's the embedded app URL in Shopify Admin or external app URL
    // We can assume external app URL for now.
    const appUrl = this.configService.getOrThrow<string>('APP_URL');

    this.logger.log(`Shopify app callback redirect to: ${appUrl}`);
    return appUrl;
  }

  private verifyHmac(query: Record<string, string>): void {
    const secret = this.configService.getOrThrow<string>('SHOPIFY_API_SECRET');
    if (!verifyShopifyHmac(query, secret)) {
      throw new UnauthorizedException('HMAC validation failed');
    }
  }

  private verifyState(state: string): void {
    const timestamp = this.stateStore.get(state);
    if (!timestamp) {
      throw new UnauthorizedException('Invalid or expired state');
    }

    // Check expiration (10 mins)
    if (Date.now() - timestamp > 10 * 60 * 1000) {
      this.stateStore.delete(state);
      throw new UnauthorizedException('State expired');
    }

    this.stateStore.delete(state);
  }

  private cleanupStates() {
    const now = Date.now();
    for (const [state, timestamp] of this.stateStore.entries()) {
      if (now - timestamp > 10 * 60 * 1000) {
        this.stateStore.delete(state);
      }
    }
  }

  private async exchangeCodeForToken(
    shop: string,
    code: string,
  ): Promise<string> {
    const url = `https://${shop}/admin/oauth/access_token`;
    const clientId = this.configService.getOrThrow<string>('SHOPIFY_API_KEY');
    const clientSecret =
      this.configService.getOrThrow<string>('SHOPIFY_API_SECRET');

    try {
      const { data } = await firstValueFrom(
        this.httpService.post(url, {
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      );
      return data.access_token;
    } catch (error) {
      this.logger.error('Failed to exchange code for token', error);
      throw new InternalServerErrorException(
        'Failed to exchange authorization code',
      );
    }
  }

  private async handlePersistence(shop: string, accessToken: string) {
    const existingIntegration =
      await this.integrationsRepo.findByPlatformDomain(shop, 'shopify');

    let orgId: string;

    if (existingIntegration) {
      orgId = existingIntegration.orgId;
    } else {
      // Create or update organization
      const orgName = shop.replace('.myshopify.com', '');
      const org = await this.organizationsRepo.createOrUpdateBySlug(
        orgName,
        shop,
      );
      orgId = org.id;
    }

    await this.integrationsRepo.upsertShopifyIntegration(
      orgId,
      shop,
      'shopify',
      accessToken,
    );
  }

  private async registerWebhooks(shop: string, accessToken: string) {
    // Register app/uninstalled
    const webhookUrl = `${this.configService.getOrThrow<string>('APP_URL')}/webhooks/shopify/uninstalled`;

    // Check if webhook exists or just try to create it. Shopify allows multiple webhooks but we want to avoid duplicates if possible.
    // However, for the 'install' flow, standard practice is just to POST.

    // NOTE: This should probably be in a queue or more robust, but inline is required for now.

    const url = `https://${shop}/admin/api/2024-01/webhooks.json`;

    try {
      await firstValueFrom(
        this.httpService.post(
          url,
          {
            webhook: {
              topic: 'app/uninstalled',
              address: webhookUrl,
              format: 'json',
            },
          },
          {
            headers: {
              'X-Shopify-Access-Token': accessToken,
            },
          },
        ),
      );
    } catch (error: any) {
      // Ignore if it says "address has already been taken" etc.
      this.logger.warn(
        `Webhook registration warning: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`,
      );
    }
  }
}
