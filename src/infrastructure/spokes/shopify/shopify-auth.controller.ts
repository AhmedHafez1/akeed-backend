import {
  Controller,
  Get,
  Query,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ShopifyAuthService } from './services/shopify-auth.service';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import {
  ShopifyCallbackQueryDto,
  ShopifyLoginQueryDto,
} from './dto/shopify-auth.dto';

@Controller('auth/shopify')
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
  }),
)
export class ShopifyAuthController {
  constructor(
    private readonly configService: ConfigService,
    private readonly shopifyAuthService: ShopifyAuthService,
  ) {}

  @Get('/')
  async login(
    @Query() query: ShopifyLoginQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { shop } = query;
    // first check if the shop is already installed
    const isInstalled = await this.shopifyAuthService.isInstalled(shop);
    if (isInstalled) {
      const appUrl = this.configService.getOrThrow<string>('APP_URL');
      res.redirect(appUrl);
      return;
    }
    const authUrl = this.shopifyAuthService.install(shop);
    res.redirect(authUrl);
  }

  @Get('/callback')
  async callback(
    @Query() query: ShopifyCallbackQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const appUrl = await this.shopifyAuthService.callback(query);
    res.redirect(appUrl);
  }
}
