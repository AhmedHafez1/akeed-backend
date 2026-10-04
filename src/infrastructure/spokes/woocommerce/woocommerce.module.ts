import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../../../modules/auth/auth.module';
import { WebhookQueueModule } from '../../../modules/webhook-queue/webhook-queue.module';
import { createRestrictedHttp } from '../../../shared/http/restricted-http';
import {
  WooCommerceApiClient,
  WOOCOMMERCE_HTTP,
} from './woocommerce-api.client';
import { WooCommerceAuthService } from './woocommerce-auth.service';
import { WooCommerceConnectionController } from './woocommerce-connection.controller';
import { WooCommerceInstallCallbackController } from './woocommerce-install-callback.controller';
import { WooCommerceWebhookController } from './woocommerce-webhook.controller';
import { WooCommerceWebhookService } from './woocommerce-webhook.service';

/**
 * The WooCommerce spoke: the application-authentication connection
 * (US-07-02) and the delivery URL that feeds the common queue (US-07-03).
 * Every request to a store goes through the restricted outbound client bound
 * here. The order normalizer lives in `WooCommerceIngestionModule`; the
 * eligibility strategy is bound in `app.module.ts`.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule, WebhookQueueModule],
  controllers: [
    WooCommerceConnectionController,
    WooCommerceInstallCallbackController,
    WooCommerceWebhookController,
  ],
  providers: [
    WooCommerceAuthService,
    WooCommerceWebhookService,
    WooCommerceApiClient,
    { provide: WOOCOMMERCE_HTTP, useFactory: () => createRestrictedHttp() },
  ],
})
export class WooCommerceModule {}
