import {
  Controller,
  Get,
  Query,
  Redirect,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ShopifyAuthService } from './services/shopify-auth.service';
import { ConfigService } from '@nestjs/config';

@Controller('auth/shopify')
export class ShopifyAuthController {
  private readonly logger = new Logger(ShopifyAuthController.name);

  constructor(
    private readonly authService: ShopifyAuthService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Redirect(undefined, 302)
  startAuth(@Query('shop') shop?: string, @Query('orgId') orgId?: string) {
    if (!shop) {
      throw new BadRequestException('Missing required query param: shop');
    }
    if (!orgId) {
      throw new BadRequestException('Missing required query param: orgId');
    }
    const url = this.authService.buildAuthorizationUrl(shop, orgId);
    this.logger.log(`Redirecting to Shopify OAuth for shop ${shop}`);
    return { url, statusCode: 302 };
  }

  @Get('callback')
  @Redirect(undefined, 302)
  async callback(@Query() query: Record<string, any>) {
    const shop = query['shop'] as string;
    const code = query['code'] as string;
    const state = query['state'] as string;

    if (!shop || !code) {
      throw new BadRequestException(
        'Missing required query params: shop, code',
      );
    }

    // Validate HMAC
    const isValid = this.authService.validateQueryHmac(query);
    if (!isValid) {
      this.logger.warn(`Invalid HMAC for Shopify OAuth callback: ${shop}`);
      throw new BadRequestException('Invalid hmac');
    }

    // Extract orgId from state
    let orgId: string | undefined;
    try {
      const decoded = Buffer.from(String(state), 'base64url').toString('utf8');
      const parsedUnknown: unknown = JSON.parse(decoded);
      if (
        parsedUnknown &&
        typeof parsedUnknown === 'object' &&
        'orgId' in parsedUnknown &&
        typeof (parsedUnknown as { orgId: unknown }).orgId === 'string'
      ) {
        orgId = (parsedUnknown as { orgId: string }).orgId;
      }
    } catch {
      this.logger.warn('Failed to parse OAuth state');
    }

    if (!orgId) {
      throw new BadRequestException('Missing orgId in state');
    }

    // Exchange code for token
    const accessToken = await this.authService.exchangeCodeForToken(shop, code);

    // Persist integration
    await this.authService.saveIntegration(orgId, shop, accessToken);

    const dashboardUrl =
      this.config.get<string>('FRONTEND_DASHBOARD_URL') ||
      'http://localhost:5173/dashboard';
    const redirectUrl = new URL(dashboardUrl);
    redirectUrl.searchParams.set('connected', 'shopify');
    redirectUrl.searchParams.set('shop', shop);

    this.logger.log(
      `Shopify connected for org ${orgId}, shop ${shop}. Redirecting to dashboard.`,
    );
    return { url: redirectUrl.toString(), statusCode: 302 };
  }
}
