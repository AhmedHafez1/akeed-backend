import { Injectable, Logger } from '@nestjs/common';
import { WebhookQueueProducer } from '../../../../modules/webhook-queue/webhook-queue.producer';
import { WebhookJobType } from '../../../../modules/webhook-queue/webhook-queue.constants';
import { ShopifyOrderWebhookDto } from '../dto/shopify-webhooks.dto';

interface WebhookAck {
  received: boolean;
  duplicate?: boolean;
}

/**
 * Thin ingestion layer for Shopify order webhooks.
 *
 * Responsibilities (fast path - must complete within Shopify's timeout):
 *  1. Enqueue the job via WebhookQueueProducer (persist + Redis + dedup).
 *  2. Return 200 OK immediately.
 *
 * All business logic (eligibility, verification, WhatsApp) runs asynchronously
 * in WebhookQueueProcessor.
 */
@Injectable()
export class ShopifyOrderWebhookService {
  private readonly logger = new Logger(ShopifyOrderWebhookService.name);

  constructor(private readonly queueProducer: WebhookQueueProducer) {}

  async handleOrderCreate(
    payload: ShopifyOrderWebhookDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    this.logger.log(
      `Received Shopify Order Webhook from ${shopDomain}: ${payload.id}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for order ${payload.id} from ${shopDomain} (topic=${topic})`,
      );
    }

    const result = await this.queueProducer.ingest({
      platform: 'shopify',
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: webhookId || `shopify-order-${payload.id}-${Date.now()}`,
      storeDomain: shopDomain,
      rawPayload: payload as unknown as Record<string, unknown>,
    });

    if (result.duplicate) {
      return { received: true, duplicate: true };
    }

    return { received: true };
  }
}
