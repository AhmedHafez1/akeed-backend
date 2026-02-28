import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ShopifyAuthService,
  type TokenExchangeResult,
} from './services/shopify-auth.service';
import type { Request, Response } from 'express';
import {
  ShopifyCallbackQueryDto,
  ShopifyLoginQueryDto,
  ShopifyTokenExchangeDto,
} from './dto/shopify-auth.dto';

@Controller('auth/shopify')
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
  }),
)
export class ShopifyAuthController {
  constructor(private readonly shopifyAuthService: ShopifyAuthService) {}

  @Get('/')
  async login(
    @Query() query: ShopifyLoginQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { shop, host } = query;
    // first check if the shop is already installed
    const isInstalled = await this.shopifyAuthService.isInstalled(shop);
    if (isInstalled) {
      const redirectUrl = this.shopifyAuthService.getPostAuthRedirectUrl(
        shop,
        host,
      );
      res.redirect(redirectUrl);
      return;
    }
    const authUrl = this.shopifyAuthService.install(shop, host);
    res.redirect(authUrl);
  }

  @Get('/check')
  async check(
    @Query() query: ShopifyLoginQueryDto,
  ): Promise<{ installed: boolean }> {
    const { shop } = query;
    const installed = await this.shopifyAuthService.isInstalled(shop);
    return { installed };
  }

  /**
   * Token Exchange — primary install path for embedded apps (App Bridge v4).
   *
   * The frontend obtains a session token via `window.shopify.idToken()` and
   * POSTs it here. The backend verifies the JWT, checks install status, and
   * if needed exchanges the token for an offline access token — all without
   * a full-page redirect out of the iframe.
   *
   * Falls through to legacy OAuth only when this endpoint is unavailable
   * (e.g. non-embedded contexts).
   */
  @Post('/token-exchange')
  async tokenExchange(
    @Body() body: ShopifyTokenExchangeDto,
  ): Promise<TokenExchangeResult> {
    return this.shopifyAuthService.tokenExchange(body.sessionToken);
  }

  @Get('/callback')
  async callback(
    @Query() query: ShopifyCallbackQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const appUrl = await this.shopifyAuthService.callback(
      req.query as Record<string, string | undefined>,
    );
    res.redirect(appUrl);
  }
}
