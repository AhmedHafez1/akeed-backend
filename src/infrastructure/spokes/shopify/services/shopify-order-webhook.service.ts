import { Injectable, Logger } from '@nestjs/common';
import { WebhookQueueProducer } from '../../../../modules/webhook-queue/webhook-queue.producer';
import { WebhookJobType } from '../../../../modules/webhook-queue/webhook-queue.constants';
import { ShopifyWebhookEventsRepository } from '../../../database/repositories/shopify-webhook-events.repository';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { ShopifyOrderWebhookDto } from '../dto/shopify-webhooks.dto';

interface WebhookAck {
  received: boolean;
  duplicate?: boolean;
}

/**
 * Thin ingestion layer for Shopify order webhooks.
 *
 * Responsibilities (fast path — must complete within Shopify's timeout):
 *  1. Deduplicate via the legacy shopify_webhook_events table (backward-compat).
 *  2. Enqueue the job via WebhookQueueProducer (persist + Redis).
 *  3. Return 200 OK immediately.
 *
 * All business logic (eligibility, verification, WhatsApp) runs asynchronously
 * in WebhookQueueProcessor.
 */
@Injectable()
export class ShopifyOrderWebhookService {
  private readonly logger = new Logger(ShopifyOrderWebhookService.name);

  constructor(
    private readonly queueProducer: WebhookQueueProducer,
    private readonly webhookEventsRepo: ShopifyWebhookEventsRepository,
    private readonly integrationsRepo: IntegrationsRepository,
  ) {}

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
        `Missing X-Shopify-Webhook-Id for order ${payload.id} from ${shopDomain}`,
      );
    }

    // Legacy deduplication (kept for backward compatibility with existing data)
    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );

    if (webhookId) {
      const isNew = await this.webhookEventsRepo.recordIfNew({
        webhookId,
        topic,
        shopDomain,
        orgId: integration?.orgId,
        integrationId: integration?.id,
      });

      if (!isNew) {
        this.logger.warn(
          `Duplicate Shopify webhook ${webhookId} ignored for shop ${shopDomain}`,
        );
        return { received: true, duplicate: true };
      }
    }

    // Enqueue for async processing — returns immediately
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
