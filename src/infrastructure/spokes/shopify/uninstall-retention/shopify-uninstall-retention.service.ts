import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { StoreDataDeletionRepository } from '../../../database/repositories/store-data-deletion.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import {
  SHOPIFY_UNINSTALL_DATA_RETENTION_MS,
  SHOPIFY_UNINSTALL_RETENTION_BATCH,
} from './shopify-uninstall-retention.constants';

export interface ShopifyUninstallRetentionResult {
  due: number;
  deletedStores: number;
  skippedReinstalled: number;
  skippedNotFound: number;
  skippedNotDue: number;
  failed: number;
}

/**
 * Shopify's 48-hour rule: deletes every store still uninstalled 48 hours
 * after `app/uninstalled`, whether or not `shop/redact` has arrived. Each
 * store goes through the same guarded routine as shop/redact, which
 * re-checks under a row lock that the store has not reinstalled, so a store
 * that came back between the select and the delete keeps its data.
 */
@Injectable()
export class ShopifyUninstallRetentionService {
  private readonly logger = new Logger(ShopifyUninstallRetentionService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly storeDataDeletion: StoreDataDeletionRepository,
  ) {}

  async run(now = new Date()): Promise<ShopifyUninstallRetentionResult> {
    const started = Date.now();
    const cutoff = new Date(
      now.getTime() - SHOPIFY_UNINSTALL_DATA_RETENTION_MS,
    ).toISOString();
    const due =
      await this.integrationsRepo.findUninstalledShopifyDueForDeletion(
        cutoff,
        SHOPIFY_UNINSTALL_RETENTION_BATCH,
      );
    const result: ShopifyUninstallRetentionResult = {
      due: due.length,
      deletedStores: 0,
      skippedReinstalled: 0,
      skippedNotFound: 0,
      skippedNotDue: 0,
      failed: 0,
    };

    for (const store of due) {
      try {
        const outcome =
          await this.storeDataDeletion.deleteUninstalledShopifyStore(
            {
              orgId: store.orgId,
              integrationId: store.id,
              platform: 'shopify',
              storeDomain: store.platformStoreUrl.trim().toLowerCase(),
            },
            { dueBefore: cutoff },
          );
        if (outcome.outcome === 'deleted') {
          result.deletedStores += 1;
          this.logger.log(
            buildBackendLog(ShopifyUninstallRetentionService.name, {
              action: 'shopify-uninstall-retention-store',
              outcome: 'success',
              orgId: store.orgId,
              integrationId: store.id,
              ordersDeleted: outcome.counts.orders,
              verificationsDeleted: outcome.counts.verifications,
              webhookEventsDeleted: outcome.counts.webhookEvents,
              messageDispatchesDeleted: outcome.counts.messageDispatches,
              integrationsDeleted: outcome.counts.integrations,
              organizationsDeleted: outcome.counts.organizations,
            }),
          );
        } else if (outcome.reason === 'reinstalled') {
          result.skippedReinstalled += 1;
          this.logger.warn(
            buildBackendLog(ShopifyUninstallRetentionService.name, {
              action: 'shopify-uninstall-retention-store',
              outcome: 'skipped',
              orgId: store.orgId,
              integrationId: store.id,
              reason: 'reinstalled',
            }),
          );
        } else if (outcome.reason === 'not_found') {
          result.skippedNotFound += 1;
        } else {
          result.skippedNotDue += 1;
        }
      } catch (error) {
        // One store (e.g. credit records blocking deletion) never stops the
        // rest; it is selected again on the next run.
        result.failed += 1;
        this.logger.error(
          buildBackendLog(ShopifyUninstallRetentionService.name, {
            action: 'shopify-uninstall-retention-store',
            outcome: 'failure',
            orgId: store.orgId,
            integrationId: store.id,
            ...normalizeError(error),
          }),
        );
      }
    }

    this.logger.log(
      buildBackendLog(ShopifyUninstallRetentionService.name, {
        action: 'shopify-uninstall-retention',
        outcome: result.failed > 0 ? 'failure' : 'success',
        ...result,
        durationMs: Date.now() - started,
      }),
    );
    return result;
  }
}
