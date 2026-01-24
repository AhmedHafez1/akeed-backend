import { Controller, Get, Query, Res } from '@nestjs/common';
import { ShopifyAuthService } from './services/shopify-auth.service';
import type { Response } from 'express';

@Controller('auth/shopify')
export class ShopifyAuthController {
  constructor(private readonly shopifyAuthService: ShopifyAuthService) {}

  @Get('/')
  async install(@Query('shop') shop: string, @Res() res: Response) {
    const authUrl = await this.shopifyAuthService.install(shop);
    return res.redirect(authUrl);
  }

  @Get('/callback')
  async callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const redirectUrl = await this.shopifyAuthService.callback(query);
    return res.redirect(redirectUrl);
  }
}
