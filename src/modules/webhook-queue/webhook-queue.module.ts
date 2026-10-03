import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WEBHOOK_QUEUE_NAME } from './webhook-queue.constants';
import { WebhookQueueProducer } from './webhook-queue.producer';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { ShopifyOrderNormalizer } from './normalizers/shopify-order.normalizer';
import { WEBHOOK_ORDER_NORMALIZERS } from './interfaces/webhook-normalizer.interface';
import { WEBHOOK_ORDER_UPDATE_HANDLERS } from './interfaces/webhook-order-update-handler.interface';
import { PhoneService } from '../../shared/services/phone.service';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookDispatchReconciler } from './webhook-dispatch-reconciler.service';
import { StandaloneManualOrderNormalizer } from './normalizers/standalone-manual-order.normalizer';
import { EasyOrdersIngestionModule } from '../../infrastructure/spokes/easyorders/easyorders-ingestion.module';
import { EasyOrdersOrderNormalizer } from '../../infrastructure/spokes/easyorders/easyorders-order.normalizer';
import { EasyOrdersStatusUpdateHandler } from '../../infrastructure/spokes/easyorders/easyorders-status-update.handler';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    EasyOrdersIngestionModule,

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
    StandaloneManualOrderNormalizer,
    {
      provide: WEBHOOK_ORDER_NORMALIZERS,
      useFactory: (
        shopify: ShopifyOrderNormalizer,
        standalone: StandaloneManualOrderNormalizer,
        easyOrders: EasyOrdersOrderNormalizer,
      ) => [shopify, standalone, easyOrders],
      inject: [
        ShopifyOrderNormalizer,
        StandaloneManualOrderNormalizer,
        EasyOrdersOrderNormalizer,
      ],
    },
    // --- Order-update handlers (status changes made in the store) ---
    {
      provide: WEBHOOK_ORDER_UPDATE_HANDLERS,
      useFactory: (easyOrders: EasyOrdersStatusUpdateHandler) => [easyOrders],
      inject: [EasyOrdersStatusUpdateHandler],
    },
  ],
  exports: [
    WebhookQueueProducer,
    WebhookDispatchService,
    WebhookDispatchReconciler,
  ],
})
export class WebhookQueueModule {}
