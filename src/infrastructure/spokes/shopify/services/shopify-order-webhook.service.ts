import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
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
      buildBackendLog('ShopifyOrderWebhookService', {
        action: 'handleOrderCreate.received',
        outcome: 'success',
        shopDomain,
        externalOrderId: String(payload.id),
      }),
    );

    if (!webhookId) {
      this.logger.warn(
        buildBackendLog('ShopifyOrderWebhookService', {
          action: 'handleOrderCreate.missingWebhookId',
          outcome: 'skipped',
          shopDomain,
          externalOrderId: String(payload.id),
          topic,
        }),
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
