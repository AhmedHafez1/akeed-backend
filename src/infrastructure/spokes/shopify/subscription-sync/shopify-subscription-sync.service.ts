import { Injectable, Logger } from '@nestjs/common';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { ShopifyBillingAdapter } from '../services/shopify-billing.adapter';
import { ShopifyBillingWebhookService } from '../services/shopify-billing-webhook.service';
import type { ShopifySubscriptionSyncSummary } from './shopify-subscription-sync.constants';

function normalize(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? '';
}

/**
 * Compares each installed store's stored subscription status with Shopify's
 * and applies any difference through the webhook's own rules. A store whose
 * check fails is left exactly as it was, so the job can only ever do nothing.
 */
@Injectable()
export class ShopifySubscriptionSyncService {
  private readonly logger = new Logger(ShopifySubscriptionSyncService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly billing: ShopifyBillingAdapter,
    private readonly billingWebhook: ShopifyBillingWebhookService,
  ) {}

  async reconcileAll(): Promise<ShopifySubscriptionSyncSummary> {
    const summary: ShopifySubscriptionSyncSummary = {
      checked: 0,
      unchanged: 0,
      corrected: 0,
      ignored: 0,
      failed: 0,
    };
    const stores = await this.integrationsRepo.findActiveShopifySubscriptions();

    for (const store of stores) {
      const subscriptionId = store.shopifySubscriptionId;
      if (!subscriptionId) continue;
      summary.checked += 1;
      try {
        const remote = await this.billing.getAppSubscriptionStatus(
          store,
          subscriptionId,
        );
        const remoteStatus = normalize(remote.status);
        if (remoteStatus === normalize(store.billingStatus)) {
          summary.unchanged += 1;
          continue;
        }

        // A plan change or an uninstall can land while Shopify answers, so
        // the rules run against the store as it is now.
        const current = await this.integrationsRepo.findByPlatformDomain(
          store.platformStoreUrl,
          'shopify',
        );
        if (!current?.isActive || current.id !== store.id) {
          summary.ignored += 1;
          continue;
        }

        const outcome = await this.billingWebhook.applySubscriptionStatus(
          current,
          subscriptionId,
          remoteStatus,
          'reconciliation',
        );
        if (outcome !== 'updated') {
          summary.ignored += 1;
          continue;
        }

        summary.corrected += 1;
        this.logger.warn(
          buildBackendLog(ShopifySubscriptionSyncService.name, {
            action: 'shopify-subscription-reconcile.corrected',
            outcome: 'success',
            orgId: store.orgId,
            integrationId: store.id,
            shopDomain: store.platformStoreUrl,
            previousBillingStatus: normalize(store.billingStatus) || 'unknown',
            billingStatus: remoteStatus,
          }),
        );
      } catch (error) {
        summary.failed += 1;
        this.logger.error(
          buildBackendLog(ShopifySubscriptionSyncService.name, {
            action: 'shopify-subscription-reconcile.store',
            outcome: 'failure',
            orgId: store.orgId,
            integrationId: store.id,
            shopDomain: store.platformStoreUrl,
            ...normalizeError(error),
          }),
        );
      }
    }

    this.logger.log(
      buildBackendLog(ShopifySubscriptionSyncService.name, {
        action: 'shopify-subscription-reconcile.run',
        outcome: summary.failed > 0 ? 'failure' : 'success',
        ...summary,
      }),
    );
    return summary;
  }
}
