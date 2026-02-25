import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { ShopifyWebhookEventsRepository } from '../../../database/repositories/shopify-webhook-events.repository';
import {
  ShopifyAppSubscriptionWebhookDto,
  ShopifyAppUninstalledDto,
} from '../dto/shopify-webhooks.dto';

interface WebhookAck {
  received: boolean;
  duplicate?: boolean;
}

@Injectable()
export class ShopifyBillingWebhookService {
  private readonly logger = new Logger(ShopifyBillingWebhookService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly webhookEventsRepo: ShopifyWebhookEventsRepository,
  ) {}

  async handleAppUninstalled(
    payload: ShopifyAppUninstalledDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    this.logger.log(
      `Received Shopify App Uninstalled Webhook from ${shopDomain}: ${payload.id}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for app uninstall from ${shopDomain}`,
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
          `Duplicate Shopify webhook ${webhookId} ignored for shop ${shopDomain}`,
        );
        return { received: true, duplicate: true };
      }
    }

    if (!orgId) {
      this.logger.warn(
        `Skipping app uninstalled: No integration/org found for domain ${shopDomain}`,
      );
      return { received: true };
    }

    await this.integrationsRepo.deleteByOrgId(orgId);
    return { received: true };
  }

  async handleAppSubscriptionUpdate(
    payload: ShopifyAppSubscriptionWebhookDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    const normalizedStatus = this.normalizeBillingStatus(payload.status);
    this.logger.log(
      `Received Shopify App Subscription Webhook from ${shopDomain}: id=${payload.id}, status=${normalizedStatus}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for app subscription update from ${shopDomain}`,
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
          `Duplicate Shopify webhook ${webhookId} ignored for shop ${shopDomain}`,
        );
        return { received: true, duplicate: true };
      }
    }

    if (!integration) {
      this.logger.warn(
        `Skipping app subscription update: No integration/org found for domain ${shopDomain}`,
      );
      return { received: true };
    }

    const now = new Date().toISOString();
    const isBlockedStatus = this.isBlockedBillingStatus(normalizedStatus);
    const isActiveStatus = normalizedStatus === 'active';
    const nextIsActive = isBlockedStatus
      ? false
      : isActiveStatus
        ? true
        : integration.isActive;

    await this.integrationsRepo.updateById(integration.id, {
      billingStatus: normalizedStatus,
      billingStatusUpdatedAt: now,
      shopifySubscriptionId: this.resolveSubscriptionId(payload),
      billingActivatedAt: isActiveStatus ? now : integration.billingActivatedAt,
      billingCanceledAt: isBlockedStatus ? now : null,
      isActive: nextIsActive,
    });

    if (isBlockedStatus) {
      this.logger.warn(
        `Shop ${shopDomain} subscription became non-billable (${normalizedStatus}). Verification processing will be blocked.`,
      );
    }

    return { received: true };
  }

  private isBlockedBillingStatus(status?: string | null): boolean {
    if (!status) {
      return false;
    }

    return ['cancelled', 'canceled', 'declined', 'expired', 'frozen'].includes(
      this.normalizeBillingStatus(status),
    );
  }

  private normalizeBillingStatus(status: string): string {
    return status.trim().toLowerCase();
  }

  private resolveSubscriptionId(
    payload: ShopifyAppSubscriptionWebhookDto,
  ): string {
    if (payload.admin_graphql_api_id) {
      return payload.admin_graphql_api_id;
    }

    return payload.id.startsWith('gid://')
      ? payload.id
      : `gid://shopify/AppSubscription/${payload.id}`;
  }
}
