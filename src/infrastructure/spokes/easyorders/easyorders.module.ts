import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../../../modules/auth/auth.module';
import { WebhookQueueModule } from '../../../modules/webhook-queue/webhook-queue.module';
import { PhoneService } from '../../../shared/services/phone.service';
import { EasyOrdersAuthService } from './easyorders-auth.service';
import { EasyOrdersConnectionController } from './easyorders-connection.controller';
import { EasyOrdersIngestionModule } from './easyorders-ingestion.module';
import { EasyOrdersInstallCallbackController } from './easyorders-install-callback.controller';
import { EasyOrdersWebhookController } from './easyorders-webhook.controller';
import { EasyOrdersWebhookService } from './easyorders-webhook.service';

/**
 * The EasyOrders spoke: the authorized connection with its disconnect and
 * reconnect (US-06-02, US-06-05) and the webhook routes that feed the common
 * queue (US-06-03). The order normalizer, the outcome adapter (US-06-04) and
 * the setup contributor live in `EasyOrdersIngestionModule`; the eligibility
 * strategy is bound in `app.module.ts`.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    WebhookQueueModule,
    EasyOrdersIngestionModule,
  ],
  controllers: [
    EasyOrdersConnectionController,
    EasyOrdersInstallCallbackController,
    EasyOrdersWebhookController,
  ],
  providers: [EasyOrdersAuthService, EasyOrdersWebhookService, PhoneService],
})
export class EasyOrdersModule {}
