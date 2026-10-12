import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../../../modules/auth/auth.module';
import { WebhookQueueModule } from '../../../modules/webhook-queue/webhook-queue.module';
import { WooCommerceAuthService } from './woocommerce-auth.service';
import { WooCommerceConnectionController } from './woocommerce-connection.controller';
import { WooCommerceIngestionModule } from './woocommerce-ingestion.module';
import { WooCommerceInstallCallbackController } from './woocommerce-install-callback.controller';
import { WooCommerceWebhookController } from './woocommerce-webhook.controller';
import { WooCommerceWebhookService } from './woocommerce-webhook.service';

/**
 * The WooCommerce spoke: the application-authentication connection
 * and the delivery URL that feeds the common queue.
 * The API client, bound to the restricted outbound client, the order
 * normalizer, the eligibility strategy, the order-update handler and the
 * outcome adapter live in `WooCommerceIngestionModule`.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    WebhookQueueModule,
    WooCommerceIngestionModule,
  ],
  controllers: [
    WooCommerceConnectionController,
    WooCommerceInstallCallbackController,
    WooCommerceWebhookController,
  ],
  providers: [WooCommerceAuthService, WooCommerceWebhookService],
})
export class WooCommerceModule {}
