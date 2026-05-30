import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { WebhookEventsRepository } from '../../../database/repositories/webhook-events.repository';
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
    private readonly webhookEventsRepo: WebhookEventsRepository,
  ) {}

  async handleAppUninstalled(
    payload: ShopifyAppUninstalledDto,
    shopDomain: string,
  ): Promise<WebhookAck> {
    this.logger.log(
      buildBackendLog('ShopifyBillingWebhookService', {
        action: 'handleAppUninstalled.received',
        outcome: 'success',
        shopDomain,
        payloadId: String(payload.id),
      }),
    );

    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );

    if (!integration) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppUninstalled.noIntegration',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    await this.integrationsRepo.deleteById(integration.id);
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
      buildBackendLog('ShopifyBillingWebhookService', {
        action: 'handleAppSubscriptionUpdate.received',
        outcome: 'success',
        shopDomain,
        payloadId: String(payload.id),
        billingStatus: normalizedStatus,
      }),
    );

    if (!webhookId) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.missingWebhookId',
          outcome: 'skipped',
          shopDomain,
        }),
      );
    }

    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );

    if (webhookId) {
      const insertedWebhookRecord = await this.webhookEventsRepo.insertIfNew({
        platform: 'shopify',
        jobType: topic || 'app_subscriptions/update',
        idempotencyKey: webhookId,
        storeDomain: shopDomain,
        orgId: integration?.orgId ?? null,
        integrationId: integration?.id ?? null,
        rawPayload: payload as unknown as Record<string, unknown>,
      });

      if (!insertedWebhookRecord) {
        this.logger.warn(
          buildBackendLog('ShopifyBillingWebhookService', {
            action: 'handleAppSubscriptionUpdate.duplicateWebhook',
            outcome: 'skipped',
            shopDomain,
            webhookId,
          }),
        );
        return { received: true, duplicate: true };
      }
    }

    if (!integration) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.noIntegration',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const now = new Date().toISOString();
    const incomingSubscriptionId = this.resolveSubscriptionId(payload);
    const isBlockedStatus = this.isBlockedBillingStatus(normalizedStatus);
    const isActiveStatus = normalizedStatus === 'active';

    // If the webhook is for a subscription that is NOT the current one and
    // the status is blocked (declined/cancelled/expired/frozen), skip the
    // update. This prevents a declined plan-upgrade attempt from disabling
    // the merchant's existing active subscription.
    const isCurrentSubscription =
      !integration.shopifySubscriptionId ||
      integration.shopifySubscriptionId === incomingSubscriptionId;

    if (!isCurrentSubscription && isBlockedStatus) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.ignoredNonCurrentBlocked',
          outcome: 'skipped',
          shopDomain,
          incomingSubscriptionId,
          currentSubscriptionId: integration.shopifySubscriptionId,
          billingStatus: normalizedStatus,
        }),
      );
      return { received: true };
    }

    const nextIsActive = isBlockedStatus
      ? false
      : isActiveStatus
        ? true
        : integration.isActive;

    await this.integrationsRepo.updateById(integration.id, {
      billingStatus: normalizedStatus,
      billingStatusUpdatedAt: now,
      shopifySubscriptionId: incomingSubscriptionId,
      billingActivatedAt: isActiveStatus ? now : integration.billingActivatedAt,
      billingCanceledAt: isBlockedStatus ? now : null,
      isActive: nextIsActive,
    });

    if (isBlockedStatus) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.nonBillable',
          outcome: 'failure',
          shopDomain,
          billingStatus: normalizedStatus,
        }),
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
