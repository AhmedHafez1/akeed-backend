import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WEBHOOK_QUEUE_NAME } from './webhook-queue.constants';
import { WebhookQueueProducer } from './webhook-queue.producer';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { ShopifyOrderNormalizer } from './normalizers/shopify-order.normalizer';
import { WEBHOOK_ORDER_NORMALIZERS } from './interfaces/webhook-normalizer.interface';
import { PhoneService } from '../../shared/services/phone.service';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookDispatchReconciler } from './webhook-dispatch-reconciler.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,

    BullModule.registerQueue({ name: WEBHOOK_QUEUE_NAME }),
  ],
  providers: [
    WebhookQueueProducer,
    WebhookQueueProcessor,
    WebhookDispatchService,
    WebhookDispatchReconciler,
    PhoneService,

    // --- Normalizers (add new platforms here) ---
    ShopifyOrderNormalizer,
    {
      provide: WEBHOOK_ORDER_NORMALIZERS,
      useFactory: (
        shopify: ShopifyOrderNormalizer,
        // When adding new platforms, inject them here:
        // salla: SallaOrderNormalizer,
        // woo: WooCommerceOrderNormalizer,
      ) => [
        shopify,
        // salla,
        // woo,
      ],
      inject: [
        ShopifyOrderNormalizer,
        // SallaOrderNormalizer,
        // WooCommerceOrderNormalizer,
      ],
    },
  ],
  exports: [
    WebhookQueueProducer,
    WebhookDispatchService,
    WebhookDispatchReconciler,
  ],
})
export class WebhookQueueModule {}
