import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { ShopifyController } from './shopify.controller';
import { WebhookQueueModule } from '../../../modules/webhook-queue/webhook-queue.module';
import { DatabaseModule } from '../../database/database.module';
import { HttpModule } from '@nestjs/axios';
import { ShopifyCommerceModule } from './shopify-commerce.module';
import { ShopifyAuthService } from './services/shopify-auth.service.js';
import { ShopifyBillingWebhookService } from './services/shopify-billing-webhook.service';
import { ShopifyGdprWebhookService } from './services/shopify-gdpr-webhook.service';
import { ShopifyAuthController } from './shopify-auth.controller.js';
import { ShopifyOrderWebhookService } from './services/shopify-order-webhook.service';
import { ShopifyHmacGuard } from './guards/shopify-hmac.guard';
import { PhoneService } from '../../../shared/services/phone.service';
import { SHOPIFY_SUBSCRIPTION_SYNC_QUEUE } from './subscription-sync/shopify-subscription-sync.constants';
import { ShopifySubscriptionSyncProcessor } from './subscription-sync/shopify-subscription-sync.processor';
import { ShopifySubscriptionSyncScheduler } from './subscription-sync/shopify-subscription-sync.scheduler';
import { ShopifySubscriptionSyncService } from './subscription-sync/shopify-subscription-sync.service';
import { SHOPIFY_UNINSTALL_RETENTION_QUEUE } from './uninstall-retention/shopify-uninstall-retention.constants';
import { ShopifyUninstallRetentionProcessor } from './uninstall-retention/shopify-uninstall-retention.processor';
import { ShopifyUninstallRetentionScheduler } from './uninstall-retention/shopify-uninstall-retention.scheduler';
import { ShopifyUninstallRetentionService } from './uninstall-retention/shopify-uninstall-retention.service';

@Module({
  imports: [
    WebhookQueueModule,
    DatabaseModule,
    HttpModule,
    ShopifyCommerceModule,
    ConfigModule,
    BullModule.registerQueue({ name: SHOPIFY_SUBSCRIPTION_SYNC_QUEUE }),
    BullModule.registerQueue({ name: SHOPIFY_UNINSTALL_RETENTION_QUEUE }),
  ],
  controllers: [ShopifyController, ShopifyAuthController],
  providers: [
    ShopifyAuthService,
    ShopifyBillingWebhookService,
    ShopifyOrderWebhookService,
    ShopifyGdprWebhookService,
    ShopifyHmacGuard,
    PhoneService,
    ShopifySubscriptionSyncService,
    ShopifySubscriptionSyncProcessor,
    ShopifySubscriptionSyncScheduler,
    ShopifyUninstallRetentionService,
    ShopifyUninstallRetentionProcessor,
    ShopifyUninstallRetentionScheduler,
  ],
  exports: [ShopifyCommerceModule, ShopifyAuthService],
})
export class ShopifyModule {}
