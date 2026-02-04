import { Module, forwardRef } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { VerificationsModule } from '../../../core/modules/verifications/verifications.module';
import { DatabaseModule } from '../../database/database.module';
import { HttpModule } from '@nestjs/axios';
import { ShopifyApiService } from './services/shopify-api.service';
import { ShopifyAuthService } from './services/shopify-auth.service.js';
import { ShopifyAuthController } from './shopify-auth.controller.js';
import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';

@Module({
  imports: [forwardRef(() => VerificationsModule), DatabaseModule, HttpModule],
  controllers: [ShopifyController, ShopifyAuthController],
  providers: [ShopifyApiService, ShopifyAuthService, ShopifyHmacGuard],
  exports: [ShopifyApiService, ShopifyAuthService],
})
export class ShopifyModule {}
