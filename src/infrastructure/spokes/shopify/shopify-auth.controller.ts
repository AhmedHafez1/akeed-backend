import { Controller, Get, Query, Res } from '@nestjs/common';
import { ShopifyAuthService } from './services/shopify-auth.service';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';

@Controller('auth/shopify')
export class ShopifyAuthController {
  constructor(
    private readonly configService: ConfigService,
    private readonly shopifyAuthService: ShopifyAuthService,
  ) {}

  @Get('/')
  async login(@Query('shop') shop: string, @Res() res: Response) {
    // first check if the shop is already installed
    const isInstalled = await this.shopifyAuthService.isInstalled(shop);
    if (isInstalled) {
      const appUrl = this.configService.getOrThrow<string>('APP_URL');
      return res.redirect(appUrl);
    }
    const authUrl = this.shopifyAuthService.install(shop);
    return res.redirect(authUrl);
  }

  @Get('/callback')
  async callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const appUrl = await this.shopifyAuthService.callback(query);
    return res.redirect(appUrl);
  }
}
