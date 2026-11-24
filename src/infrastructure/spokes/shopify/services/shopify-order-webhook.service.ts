import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import { shopifyError } from '../shopify.errors';
import { WebhookQueueProducer } from '../../../../modules/webhook-queue/webhook-queue.producer';
import { WebhookJobType } from '../../../../modules/webhook-queue/webhook-queue.constants';
import {
  ShopifyOrderUpdatedWebhookDto,
  ShopifyOrderWebhookDto,
} from '../dto/shopify-webhooks.dto';
import { ConfigService } from '@nestjs/config';
import { readShippingNotificationsConfig } from '../../../../shared/config/shipping-notifications.config';
import { projectShopifyOrderUpdate } from './shopify-shipping-event.mapper';

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

  constructor(
    private readonly queueProducer: WebhookQueueProducer,
    private readonly config: ConfigService,
  ) {}

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
      throw shopifyError(
        'SHOPIFY_WEBHOOK_IDENTITY_INVALID',
        'A shop domain and provider order ID are required for webhook identity',
      );
    }

    if (payload.test && !this.shouldProcessTestOrders()) {
      this.logger.log(
        buildBackendLog('ShopifyOrderWebhookService', {
          action: 'handleOrderCreate.testOrder',
          outcome: 'skipped',
          shopDomain: normalizedShopDomain,
          externalOrderId,
        }),
      );
      return { received: true };
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

  /**
   * `orders/updated` fires on every order edit, Akeed's own tag writes
   * included. Only stores that switched shipping notifications on have it
   * stored; every other delivery is acknowledged and dropped. Only the fields
   * the shipping source reads are stored: no customer or address data.
   */
  async handleOrderUpdated(
    payload: ShopifyOrderUpdatedWebhookDto,
    shopDomain: string,
    webhookId: string,
  ): Promise<WebhookAck> {
    const normalizedShopDomain = shopDomain?.trim().toLowerCase();
    const externalOrderId = String(payload.id ?? '').trim();
    if (
      !normalizedShopDomain ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalizedShopDomain) ||
      !externalOrderId
    ) {
      throw shopifyError(
        'SHOPIFY_WEBHOOK_IDENTITY_INVALID',
        'A shop domain and provider order ID are required for webhook identity',
      );
    }

    if (!readShippingNotificationsConfig(this.config).enabled) {
      return { received: true };
    }
    if (payload.test === true) return { received: true };

    const updatedAt =
      typeof payload.updated_at === 'string' ? payload.updated_at.trim() : '';
    const result = await this.queueProducer.ingest({
      platform: 'shopify',
      jobType: WebhookJobType.ORDER_UPDATE,
      idempotencyKey:
        webhookId?.trim() ||
        `fallback:order.update:${externalOrderId}:${updatedAt}`,
      storeDomain: normalizedShopDomain,
      rawPayload: projectShopifyOrderUpdate(
        payload as unknown as Record<string, unknown>,
      ),
      admit: (integration) =>
        integration.shippingNotificationsEnabled === true
          ? null
          : 'shipping_feature_off',
    });

    return result.duplicate
      ? { received: true, duplicate: true }
      : { received: true };
  }

  private shouldProcessTestOrders(): boolean {
    return this.config.get<string>('SHOPIFY_PROCESS_TEST_ORDERS') === 'true';
  }
}
