import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { ShopifyWebhookEventsRepository } from '../../../database/repositories/shopify-webhook-events.repository';
import {
  ShopifyCustomersDataRequestDto,
  ShopifyCustomersRedactDto,
  ShopifyShopRedactDto,
} from '../dto/shopify-webhooks.dto';

interface WebhookAck {
  received: boolean;
  duplicate?: boolean;
}

@Injectable()
export class ShopifyGdprWebhookService {
  private readonly logger = new Logger(ShopifyGdprWebhookService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly webhookEventsRepo: ShopifyWebhookEventsRepository,
  ) {}

  async handleCustomerDataRequest(
    payload: ShopifyCustomersDataRequestDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    const customerId = payload.customer?.id ?? 'unknown';
    this.logger.log(
      `Received Shopify GDPR Data Request from ${shopDomain}: customer=${customerId}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for GDPR data request from ${shopDomain}`,
      );
    }

    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );
    const orgId = integration?.orgId;

    if (webhookId) {
      const isNew = await this.webhookEventsRepo.recordIfNew({
        webhookId,
        topic,
        shopDomain,
        orgId,
        integrationId: integration?.id,
      });

      if (!isNew) {
        this.logger.warn(
          `Duplicate Shopify GDPR data request ${webhookId} ignored for shop ${shopDomain}`,
        );
        return { received: true, duplicate: true };
      }
    }

    if (!integration) {
      this.logger.warn(
        `GDPR data request received but no integration found for ${shopDomain}`,
      );
    }

    return { received: true };
  }

  async handleCustomerRedact(
    payload: ShopifyCustomersRedactDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    const customerId = payload.customer?.id ?? 'unknown';
    this.logger.log(
      `Received Shopify GDPR Customer Redact from ${shopDomain}: customer=${customerId}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for GDPR customer redact from ${shopDomain}`,
      );
    }

    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );
    const orgId = integration?.orgId;

    if (webhookId) {
      const isNew = await this.webhookEventsRepo.recordIfNew({
        webhookId,
        topic,
        shopDomain,
        orgId,
        integrationId: integration?.id,
      });

      if (!isNew) {
        this.logger.warn(
          `Duplicate Shopify GDPR customer redact ${webhookId} ignored for shop ${shopDomain}`,
        );
        return { received: true, duplicate: true };
      }
    }

    if (!integration) {
      this.logger.warn(
        `GDPR customer redact received but no integration found for ${shopDomain}`,
      );
    }

    return { received: true };
  }

  async handleShopRedact(
    payload: ShopifyShopRedactDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    const resolvedShopDomain = payload.shop_domain ?? shopDomain;
    this.logger.log(
      `Received Shopify GDPR Shop Redact from ${resolvedShopDomain}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for GDPR shop redact from ${shopDomain}`,
      );
    }

    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );
    const orgId = integration?.orgId;

    if (webhookId) {
      const isNew = await this.webhookEventsRepo.recordIfNew({
        webhookId,
        topic,
        shopDomain,
        orgId,
        integrationId: integration?.id,
      });

      if (!isNew) {
        this.logger.warn(
          `Duplicate Shopify GDPR shop redact ${webhookId} ignored for shop ${shopDomain}`,
        );
        return { received: true, duplicate: true };
      }
    }

    if (!orgId) {
      this.logger.warn(
        `GDPR shop redact received but no integration/org found for ${shopDomain}`,
      );
      return { received: true };
    }

    await this.integrationsRepo.deleteByOrgId(orgId);
    this.logger.log(`Removed Shopify integration data for org ${orgId}`);

    return { received: true };
  }
}
