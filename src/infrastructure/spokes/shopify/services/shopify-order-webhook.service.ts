import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
    const normalizedShopDomain = shopDomain?.trim().toLowerCase();
    const externalOrderId = String(payload.id ?? '').trim();
    if (
      !normalizedShopDomain ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalizedShopDomain) ||
      !externalOrderId
    ) {
      throw new BadRequestException(
        'A shop domain and provider order ID are required for webhook identity',
      );
    }

    this.logger.log(
      buildBackendLog('ShopifyOrderWebhookService', {
        action: 'handleOrderCreate.received',
        outcome: 'success',
        shopDomain: normalizedShopDomain,
        externalOrderId,
      }),
    );

    if (!webhookId) {
      this.logger.warn(
        buildBackendLog('ShopifyOrderWebhookService', {
          action: 'handleOrderCreate.missingWebhookId',
          outcome: 'skipped',
          shopDomain: normalizedShopDomain,
          externalOrderId,
          topic,
        }),
      );
    }

    const result = await this.queueProducer.ingest({
      platform: 'shopify',
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey:
        webhookId?.trim() || `fallback:order.create:${externalOrderId}`,
      storeDomain: normalizedShopDomain,
      rawPayload: payload as unknown as Record<string, unknown>,
    });

    if (result.duplicate) {
      return { received: true, duplicate: true };
    }

    return { received: true };
  }
}
