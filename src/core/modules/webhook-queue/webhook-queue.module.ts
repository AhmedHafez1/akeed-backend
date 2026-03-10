import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../../infrastructure/database/database.module';
import { WEBHOOK_QUEUE_NAME } from './webhook-queue.constants';
import { WebhookQueueProducer } from './webhook-queue.producer';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { ShopifyOrderNormalizer } from './normalizers/shopify-order.normalizer';
import { WEBHOOK_ORDER_NORMALIZERS } from './interfaces/webhook-normalizer.interface';
import { PhoneService } from '../../services/phone.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,

    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL', 'redis://localhost:6379'),
        },
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 3_000 },
          removeOnComplete: { age: 7 * 24 * 3_600 },
          removeOnFail: { age: 30 * 24 * 3_600 },
        },
      }),
    }),

    BullModule.registerQueue({ name: WEBHOOK_QUEUE_NAME }),
  ],
  providers: [
    WebhookQueueProducer,
    WebhookQueueProcessor,
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
  exports: [WebhookQueueProducer],
})
export class WebhookQueueModule {}
