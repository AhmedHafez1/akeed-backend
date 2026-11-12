import { Injectable, Logger, Optional } from '@nestjs/common';
import { CapacityRecoveryProducer } from '../../../../modules/capacity-recovery/capacity-recovery.producer';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { VerificationAutoCancellationsRepository } from '../../../database/repositories/verification-auto-cancellations.repository';
import { VerificationsRepository } from '../../../database/repositories/verifications.repository';
import { WebhookEventsRepository } from '../../../database/repositories/webhook-events.repository';
import {
  ShopifyAppSubscriptionWebhookDto,
  ShopifyAppUninstalledDto,
} from '../dto/shopify-webhooks.dto';

type ShopifyIntegration = NonNullable<
  Awaited<ReturnType<IntegrationsRepository['findByPlatformDomain']>>
>;

export type SubscriptionStatusSource = 'webhook' | 'reconciliation';

export type SubscriptionStatusOutcome =
  | 'updated'
  | 'ignored_non_current'
  | 'ignored_status';

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
    private readonly verificationsRepo: VerificationsRepository,
    private readonly autoCancellations: VerificationAutoCancellationsRepository,
    @Optional()
    private readonly capacityRecovery?: CapacityRecoveryProducer,
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

    const uninstalledAt = new Date().toISOString();
    await this.integrationsRepo.markShopifyUninstalled(
      integration.id,
      uninstalledAt,
    );

    // Shopify's 48-hour rule: nothing is deleted here. A reinstall inside the
    // window gets its history back; the uninstall-retention job (or
    // shop/redact) deletes everything once it closes. What stops now is all
    // work that could still message this store's customers: automatic
    // cancellations and every open verification, closed with a reason no
    // retry or recovery reopens, so a reinstall never sends old orders.
    const stoppedAutoCancellations =
      await this.autoCancellations.stopPendingForIntegration(
        integration.orgId,
        integration.id,
        'store_uninstalled',
        null,
      );
    const closed = await this.verificationsRepo.closeOpenForUninstalledStore(
      integration.orgId,
      integration.id,
      uninstalledAt,
    );
    this.logger.log(
      buildBackendLog('ShopifyBillingWebhookService', {
        action: 'handleAppUninstalled.closedOpenWork',
        outcome: 'success',
        shopDomain,
        orgId: integration.orgId,
        integrationId: integration.id,
        failedVerifications: closed.failed,
        expiredVerifications: closed.expired,
        stoppedAutoCancellations,
      }),
    );
    return { received: true };
  }

  async handleAppSubscriptionUpdate(
    payload: ShopifyAppSubscriptionWebhookDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    const incomingSubscriptionId =
      payload.app_subscription.admin_graphql_api_id;
    const normalizedStatus = this.normalizeBillingStatus(
      payload.app_subscription.status,
    );
    this.logger.log(
      buildBackendLog('ShopifyBillingWebhookService', {
        action: 'handleAppSubscriptionUpdate.received',
        outcome: 'success',
        shopDomain,
        payloadId: incomingSubscriptionId,
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

    if (!integration.isActive) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.integrationUninstalled',
          outcome: 'skipped',
          shopDomain,
          billingStatus: normalizedStatus,
        }),
      );
      return { received: true };
    }

    await this.applySubscriptionStatus(
      integration,
      incomingSubscriptionId,
      normalizedStatus,
      'webhook',
    );
    return { received: true };
  }

  /**
   * Applies a Shopify subscription status to the installed store that holds
   * that subscription. The webhook and the daily reconciliation both go
   * through here, so a missed webhook is repaired by exactly the same rules.
   */
  async applySubscriptionStatus(
    integration: ShopifyIntegration,
    subscriptionId: string,
    status: string,
    source: SubscriptionStatusSource,
  ): Promise<SubscriptionStatusOutcome> {
    const shopDomain = integration.platformStoreUrl;
    const normalizedStatus = this.normalizeBillingStatus(status);
    const now = new Date().toISOString();
    const isBlockedStatus = this.isBlockedBillingStatus(normalizedStatus);
    const isActiveStatus = normalizedStatus === 'active';

    // Only the billing callback adopts a subscription. A new one's webhook can
    // arrive before the callback, and saving its id here would make the
    // callback cancel it as the "existing" subscription. A failed upgrade's
    // webhook must not disable the live plan, or a free store with no
    // subscription.
    if (integration.shopifySubscriptionId !== subscriptionId) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.ignoredNonCurrent',
          outcome: 'skipped',
          shopDomain,
          incomingSubscriptionId: subscriptionId,
          source,
          currentSubscriptionId: integration.shopifySubscriptionId,
          billingStatus: normalizedStatus,
        }),
      );
      return 'ignored_non_current';
    }

    if (!isActiveStatus && !isBlockedStatus) {
      this.logger.log(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.ignoredStatus',
          outcome: 'skipped',
          shopDomain,
          source,
          billingStatus: normalizedStatus,
        }),
      );
      return 'ignored_status';
    }

    // billingActivatedAt anchors the store's 30-day allowance periods, so a
    // status update must never touch it.
    await this.integrationsRepo.updateById(integration.id, {
      billingStatus: normalizedStatus,
      billingStatusUpdatedAt: now,
      billingCanceledAt: isBlockedStatus ? now : null,
    });

    // A subscription that is active again can send its blocked orders.
    if (isActiveStatus) {
      await this.capacityRecovery?.request(
        integration.orgId,
        'subscription_active',
      );
    }

    if (isBlockedStatus) {
      this.logger.warn(
        buildBackendLog('ShopifyBillingWebhookService', {
          action: 'handleAppSubscriptionUpdate.nonBillable',
          outcome: 'failure',
          shopDomain,
          source,
          billingStatus: normalizedStatus,
        }),
      );
    }

    return 'updated';
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
}
