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
import type { AxiosError } from 'axios';
import { createClient } from '@supabase/supabase-js';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { OrganizationsRepository } from '../../../database/repositories/organizations.repository';
import { MembershipsRepository } from '../../../database/repositories/memberships.repository';
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
    private readonly membershipsRepo: MembershipsRepository,
  ) {}

  async isInstalled(shop: string): Promise<boolean> {
    return Boolean(
      await this.integrationsRepo.findByPlatformDomain(shop, 'shopify'),
    );
  }

  install(shop: string, host?: string): string {
    if (!validateShop(shop)) {
      throw new BadRequestException('Invalid shop parameter');
    }

    this.logger.log(`Installing Shopify app for shop: ${shop}`);

    const apiKey = this.configService.getOrThrow<string>('SHOPIFY_API_KEY');
    const scopes = this.configService.getOrThrow<string>('SHOPIFY_SCOPES');
    const apiUrl = this.configService.getOrThrow<string>('API_URL');
    const redirectUrl = new URL(`${apiUrl}/auth/shopify/callback`);
    if (host) {
      redirectUrl.searchParams.set('host', host);
    }
    const redirectUri = redirectUrl.toString();
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

  async callback(
    rawQuery: Record<string, string | undefined>,
  ): Promise<string> {
    const { shop, code, state, hmac, host } = rawQuery;

    if (!shop || !code || !state || !hmac) {
      throw new BadRequestException('Missing required parameters');
    }

    if (!validateShop(shop)) {
      throw new BadRequestException('Invalid shop parameter');
    }

    this.logger.log(`Shopify app callback for shop: ${shop}`);

    this.verifyHmac(rawQuery);
    this.verifyState(state);

    // Exchange code for access token
    const accessToken = await this.exchangeCodeForToken(shop, code);

    // Persist integration
    await this.handlePersistence(shop, accessToken);

    // Register Webhooks (non-blocking)
    // Do not await to avoid delaying the OAuth callback redirect.
    void this.registerWebhooks(shop, accessToken);

    // Redirect to app dashboard after successful installation
    const redirectUrl = this.getPostAuthRedirectUrl(shop, host);

    this.logger.log(`Shopify app callback redirect to: ${redirectUrl}`);
    return redirectUrl;
  }

  getPostAuthRedirectUrl(shop: string, host?: string): string {
    if (host) {
      const apiKey = this.configService.getOrThrow<string>('SHOPIFY_API_KEY');
      const redirectUrl = new URL(`https://${shop}/admin/apps/${apiKey}`);
      redirectUrl.searchParams.set('host', host);
      redirectUrl.searchParams.set('shop', shop);
      return redirectUrl.toString();
    }

    return this.configService.getOrThrow<string>('APP_URL');
  }

  private verifyHmac(query: Record<string, string | undefined>): void {
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
        this.httpService.post<{ access_token: string }>(url, {
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      );
      return data.access_token;
    } catch (error: unknown) {
      this.logger.error('Failed to exchange code for token', error as Error);
      throw new InternalServerErrorException(
        'Failed to exchange authorization code',
      );
    }
  }

  private async handlePersistence(shop: string, accessToken: string) {
    const existingIntegration =
      await this.integrationsRepo.findByPlatformDomain(shop, 'shopify');

    let orgId: string;
    let isNewOrganization = false;

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
      isNewOrganization = true;
    }

    await this.integrationsRepo.upsertShopifyIntegration(
      orgId,
      shop,
      'shopify',
      accessToken,
    );

    // Create or get user and membership (only for new organizations)
    if (isNewOrganization) {
      try {
        const user = await this.createOrGetUser(shop);
        await this.membershipsRepo.createOrUpdateMembership(
          orgId,
          user.id,
          'owner',
        );
        this.logger.log(
          `Created user and membership for shop: ${shop}, userId: ${user.id}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to create user/membership for shop: ${shop}`,
          error,
        );
        // Don't throw - allow installation to continue even if user creation fails
        // This can be retried later or handled manually
      }
    }
  }

  private async createOrGetUser(shop: string): Promise<{ id: string }> {
    const supabaseUrl = this.configService.getOrThrow<string>('SUPABASE_URL');
    const supabaseServiceKey = this.configService.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Use shop domain as email identifier
    const email = `${shop}@akeed-shopify.internal`;

    // First, try to find existing user by email
    const { data: existingUser } = await supabase.auth.admin.listUsers();
    const user = existingUser?.users?.find((u) => u.email === email);

    if (user) {
      this.logger.log(
        `Found existing user for shop: ${shop}, userId: ${user.id}`,
      );
      return { id: user.id };
    }

    // Create new user with random password (merchant won't use it)
    const password = this.generateSecurePassword();
    const { data: newUser, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm email
      user_metadata: {
        shop_domain: shop,
        platform: 'shopify',
        created_via: 'oauth_installation',
      },
    });

    if (error || !newUser?.user) {
      this.logger.error(`Failed to create user for shop: ${shop}`, error);
      throw new InternalServerErrorException(
        `Failed to create user account: ${error?.message || 'Unknown error'}`,
      );
    }

    this.logger.log(
      `Created new user for shop: ${shop}, userId: ${newUser.user.id}`,
    );
    return { id: newUser.user.id };
  }

  private generateSecurePassword(): string {
    // Generate a cryptographically secure random password
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    const length = 32;
    let password = '';
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    for (let i = 0; i < length; i++) {
      password += chars[array[i] % chars.length];
    }
    return password;
  }

  private async registerWebhooks(
    shop: string,
    accessToken: string,
  ): Promise<void> {
    const apiUrl = this.configService.getOrThrow<string>('API_URL');
    const apiVersion = this.getShopifyApiVersion();

    const definitions = this.getWebhookDefinitions(apiUrl);

    for (const def of definitions) {
      await this.registerWebhookWithRetry(
        shop,
        accessToken,
        apiVersion,
        def.topic,
        def.address,
      );
    }
  }

  private getShopifyApiVersion(): string {
    // Use configured version if present, fallback to the one previously used in the codebase
    return this.configService.get<string>('SHOPIFY_API_VERSION') ?? '2026-01';
  }

  private getWebhookDefinitions(
    appUrl: string,
  ): Array<{ topic: string; address: string }> {
    // Easy to extend: add/remove topics here.
    return [
      // Mandatory and highest priority
      {
        topic: 'app/uninstalled',
        address: `${appUrl}/webhooks/shopify/uninstalled`,
      },
      // Business-related topics already used by the app
      {
        topic: 'orders/create',
        address: `${appUrl}/webhooks/shopify/orders-create`,
      },
    ];
  }

  private async registerWebhookWithRetry(
    shop: string,
    accessToken: string,
    apiVersion: string,
    topic: string,
    address: string,
  ): Promise<void> {
    const url = `https://${shop}/admin/api/${apiVersion}/webhooks.json`;

    const payload = {
      webhook: {
        topic,
        address,
        format: 'json',
      },
    };

    const headers = {
      'X-Shopify-Access-Token': accessToken,
    };

    const maxAttempts = 3;
    let attempt = 0;
    let lastError: AxiosError<unknown> | null = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        await firstValueFrom(this.httpService.post(url, payload, { headers }));
        this.logger.log(`Webhook registered: topic=${topic} shop=${shop}`);
        return;
      } catch (error: unknown) {
        // Idempotent success: Shopify returns 422 if address already exists
        const axiosError = error as AxiosError<unknown>;
        const status = axiosError.response?.status;
        const errData = axiosError.response?.data;
        const isAlreadyExists = status === 422;

        if (isAlreadyExists) {
          this.logger.log(
            `Webhook already exists (treated as success): topic=${topic} shop=${shop}`,
          );
          return;
        }

        lastError = axiosError ?? null;
        this.logger.warn(
          `Webhook registration failed (attempt ${attempt}/${maxAttempts}): topic=${topic} shop=${shop} status=${status} details=${errData ? JSON.stringify(errData) : axiosError.message}`,
        );

        if (attempt < maxAttempts) {
          // Exponential backoff: 500ms, 1000ms
          const delayMs = 500 * Math.pow(2, attempt - 1);
          await this.sleep(delayMs);
        }
      }
    }

    // Final failure (graceful): log and move on without throwing
    if (lastError) {
      const status = lastError.response?.status;
      const errData = lastError.response?.data;
      this.logger.error(
        `Webhook registration ultimately failed: topic=${topic} shop=${shop} status=${status} details=${errData ? JSON.stringify(errData) : lastError.message}`,
      );
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
