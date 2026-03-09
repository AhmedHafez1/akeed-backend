import { Module, forwardRef } from '@nestjs/common';
import { ShopifyController } from './shopify.controller';
import { VerificationsModule } from '../../../core/modules/verifications/verifications.module';
import { WebhookQueueModule } from '../../../core/modules/webhook-queue/webhook-queue.module';
import { DatabaseModule } from '../../database/database.module';
import { HttpModule } from '@nestjs/axios';
import { ShopifyApiService } from './services/shopify-api.service';
import { ShopifyAuthService } from './services/shopify-auth.service.js';
import { ShopifyBillingWebhookService } from './services/shopify-billing-webhook.service';
import { ShopifyGdprWebhookService } from './services/shopify-gdpr-webhook.service';
import { ShopifyAuthController } from './shopify-auth.controller.js';
import { ShopifyOrderWebhookService } from './services/shopify-order-webhook.service';
import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';

@Module({
  imports: [
    forwardRef(() => VerificationsModule),
    WebhookQueueModule,
    DatabaseModule,
    HttpModule,
  ],
  controllers: [ShopifyController, ShopifyAuthController],
  providers: [
    ShopifyApiService,
    ShopifyAuthService,
    ShopifyBillingWebhookService,
    ShopifyOrderWebhookService,
    ShopifyGdprWebhookService,
    ShopifyHmacGuard,
  ],
  exports: [ShopifyApiService, ShopifyAuthService],
})
export class ShopifyModule {}
