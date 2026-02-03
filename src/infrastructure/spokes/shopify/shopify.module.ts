import { Module, forwardRef } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { CoreModule } from '../../../core/core.module';
import { DatabaseModule } from '../../database/database.module';
import { HttpModule } from '@nestjs/axios';
import { ShopifyApiService } from './services/shopify-api.service';
import { ShopifyAuthService } from './services/shopify-auth.service.js';
import { ShopifyAuthController } from './shopify-auth.controller.js';
import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';

@Module({
  imports: [forwardRef(() => CoreModule), DatabaseModule, HttpModule],
  controllers: [ShopifyController, ShopifyAuthController],
  providers: [ShopifyApiService, ShopifyAuthService, ShopifyHmacGuard],
  exports: [ShopifyApiService, ShopifyAuthService],
})
export class ShopifyModule {}
