import { Injectable, Logger } from '@nestjs/common';
import { databaseErrorCode } from '../../../../shared/database/serializable-retry';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import { PhoneService } from '../../../../shared/services/phone.service';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import {
  hasShopifyCustomerKeys,
  OrdersRepository,
  type ShopifyCustomerKeys,
} from '../../../database/repositories/orders.repository';
import { StoreDataDeletionRepository } from '../../../database/repositories/store-data-deletion.repository';
import { WebhookEventsRepository } from '../../../database/repositories/webhook-events.repository';
import {
  ShopifyCustomersDataRequestDto,
  ShopifyCustomersRedactDto,
  ShopifyShopRedactDto,
} from '../dto/shopify-webhooks.dto';
import { buildShopifyCustomerKeys } from './shopify-customer-keys';

interface WebhookAck {
  received: boolean;
  duplicate?: boolean;
}

/** Which keys a request carried, for logs that must not hold the values. */
function keyPresence(keys: ShopifyCustomerKeys) {
  return {
    hasCustomerId: Boolean(keys.customerId),
    hasEmail: Boolean(keys.email),
    hasPhone: keys.phones.length > 0,
    orderIdsCount: keys.externalOrderIds.length,
  };
}

@Injectable()
export class ShopifyGdprWebhookService {
  private readonly logger = new Logger(ShopifyGdprWebhookService.name);

  constructor(
    private readonly ordersRepo: OrdersRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly webhookEventsRepo: WebhookEventsRepository,
    private readonly storeDataDeletion: StoreDataDeletionRepository,
    private readonly phoneService: PhoneService,
  ) {}

  async handleCustomerDataRequest(
    payload: ShopifyCustomersDataRequestDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    const customerId = payload.customer?.id ?? 'unknown';
    this.logger.log(
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleCustomerDataRequest.received',
        outcome: 'success',
        shopDomain,
        customerId: String(customerId),
      }),
    );

    const { integration, orgId, isDuplicate } =
      await this.resolveWebhookContext({
        shopDomain,
        webhookId,
        topic,
        logLabel: 'GDPR data request',
        rawPayload: payload as unknown as Record<string, unknown>,
      });

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    if (!integration || !orgId) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleCustomerDataRequest.noIntegration',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const keys = buildShopifyCustomerKeys(
      payload.customer,
      payload.orders_requested,
      this.phoneService,
    );
    if (!hasShopifyCustomerKeys(keys)) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleCustomerDataRequest.noIdentifiers',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const orders = await this.ordersRepo.findShopifyCustomerOrders(
      orgId,
      integration.id,
      keys,
    );
    const filteredOrders = this.filterOrdersByRequestedIds(
      orders,
      payload.orders_requested ?? [],
    );

    const exportPayload = filteredOrders.map((order) => ({
      id: order.id,
      externalOrderId: order.externalOrderId,
      orderNumber: order.orderNumber,
      customerPhone: order.customerPhone,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      totalPrice: order.totalPrice,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
      rawPayload: order.rawPayload,
      createdAt: order.createdAt,
      verifications: order.verifications.map((verification) => ({
        id: verification.id,
        status: verification.status,
        waMessageId: verification.waMessageId,
        createdAt: verification.createdAt,
        updatedAt: verification.updatedAt,
        metadata: verification.metadata,
      })),
    }));

    this.logger.log(
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleCustomerDataRequest.exportPrepared',
        outcome: 'success',
        shopDomain,
        ordersCount: exportPayload.length,
        ...keyPresence(keys),
      }),
    );

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
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleCustomerRedact.received',
        outcome: 'success',
        shopDomain,
        customerId: String(customerId),
      }),
    );

    const { integration, orgId, isDuplicate, webhookEventId } =
      await this.resolveWebhookContext({
        shopDomain,
        webhookId,
        topic,
        logLabel: 'GDPR customer redact',
        rawPayload: payload as unknown as Record<string, unknown>,
      });

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    if (!integration || !orgId) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleCustomerRedact.noIntegration',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const keys = buildShopifyCustomerKeys(
      payload.customer,
      payload.orders_to_redact,
      this.phoneService,
    );
    if (!hasShopifyCustomerKeys(keys)) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleCustomerRedact.noIdentifiers',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const redacted = await this.ordersRepo.redactShopifyCustomer(
      orgId,
      integration.id,
      keys,
    );

    // The request itself carried the customer's email and phone; keep only
    // the ids, which are enough to show what was redacted and to replay it.
    if (webhookEventId) {
      await this.webhookEventsRepo.replaceRawPayload(webhookEventId, {
        customer: { id: keys.customerId ?? null },
        orders_to_redact: keys.externalOrderIds,
      });
    }

    this.logger.log(
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleCustomerRedact.completed',
        outcome: 'success',
        shopDomain,
        redactedOrders: redacted.orders,
        clearedVerifications: redacted.verifications,
        scrubbedWebhookEvents: redacted.webhookEvents,
        ...keyPresence(keys),
      }),
    );

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
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleShopRedact.received',
        outcome: 'success',
        shopDomain: resolvedShopDomain,
      }),
    );

    const { integration, orgId, isDuplicate, webhookEventId } =
      await this.resolveWebhookContext({
        shopDomain,
        webhookId,
        topic,
        logLabel: 'GDPR shop redact',
        rawPayload: payload as unknown as Record<string, unknown>,
      });

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    if (!orgId || !integration) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleShopRedact.noIntegration',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    // One transaction, through the same guarded routine as the 48-hour job.
    // A store that reinstalled is never deleted: shop/redact can still arrive
    // after a reinstall. The request row itself is kept (detached from the
    // organization) so a redelivery is still answered as a duplicate.
    const result = await this.storeDataDeletion.deleteUninstalledShopifyStore(
      {
        orgId,
        integrationId: integration.id,
        platform: 'shopify',
        storeDomain: shopDomain.trim().toLowerCase(),
      },
      { keepWebhookEventId: webhookEventId },
    );

    if (result.outcome === 'skipped') {
      const context = {
        outcome: 'skipped' as const,
        shopDomain,
        orgId,
        integrationId: integration.id,
        reason: result.reason,
      };
      if (result.reason === 'reinstalled')
        this.logger.warn(
          buildBackendLog('ShopifyGdprWebhookService', {
            action: 'handleShopRedact.storeReinstalled',
            ...context,
          }),
        );
      else
        this.logger.log(
          buildBackendLog('ShopifyGdprWebhookService', {
            action: 'handleShopRedact.alreadyDeleted',
            ...context,
          }),
        );
      return { received: true };
    }

    const deleted = result.counts;
    this.logger.log(
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleShopRedact.completed',
        outcome: 'success',
        orgId,
        webhookEventsDeleted: deleted.webhookEvents,
        usageDeleted: deleted.integrationMonthlyUsage,
        verificationsDeleted: deleted.verifications,
        messageDispatchesDeleted: deleted.messageDispatches,
        orderImportBatchesDeleted: deleted.orderImportBatches,
        ordersDeleted: deleted.orders,
        metaWebhookEventsDeleted: deleted.metaWebhookEvents,
        providerMessageReceiptsDeleted: deleted.providerMessageReceipts,
        integrationsDeleted: deleted.integrations,
        membershipsDeleted: deleted.memberships,
        organizationsDeleted: deleted.organizations,
      }),
    );

    return { received: true };
  }

  private async resolveWebhookContext(params: {
    shopDomain: string;
    webhookId: string;
    topic: string;
    logLabel: string;
    rawPayload: Record<string, unknown>;
  }): Promise<{
    integration?: Awaited<
      ReturnType<IntegrationsRepository['findByPlatformDomain']>
    >;
    orgId?: string;
    isDuplicate: boolean;
    webhookEventId?: string;
  }> {
    if (!params.webhookId) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'resolveWebhookContext.missingWebhookId',
          outcome: 'skipped',
          shopDomain: params.shopDomain,
          logLabel: params.logLabel,
        }),
      );
    }

    let integration = await this.integrationsRepo.findByPlatformDomain(
      params.shopDomain,
      'shopify',
    );

    if (params.webhookId) {
      const record = (owner: typeof integration) =>
        this.webhookEventsRepo.insertIfNew({
          platform: 'shopify',
          jobType: params.topic || params.logLabel,
          idempotencyKey: params.webhookId,
          storeDomain: params.shopDomain,
          orgId: owner?.orgId ?? null,
          integrationId: owner?.id ?? null,
          rawPayload: params.rawPayload,
        });
      let insertedWebhookRecord: Awaited<ReturnType<typeof record>>;
      try {
        insertedWebhookRecord = await record(integration);
      } catch (error) {
        // The store was deleted between the lookup and the insert (the
        // 48-hour job ran at the same moment): look again, and record the
        // request against what is left, which is nothing to delete.
        if (!integration || databaseErrorCode(error) !== '23503') throw error;
        integration = await this.integrationsRepo.findByPlatformDomain(
          params.shopDomain,
          'shopify',
        );
        insertedWebhookRecord = await record(integration);
      }
      const orgId = integration?.orgId;

      if (!insertedWebhookRecord) {
        this.logger.warn(
          buildBackendLog('ShopifyGdprWebhookService', {
            action: 'resolveWebhookContext.duplicateWebhook',
            outcome: 'skipped',
            shopDomain: params.shopDomain,
            webhookId: params.webhookId,
            logLabel: params.logLabel,
          }),
        );
        return { integration, orgId, isDuplicate: true };
      }

      return {
        integration,
        orgId,
        isDuplicate: false,
        webhookEventId: insertedWebhookRecord.id,
      };
    }

    return { integration, orgId: integration?.orgId, isDuplicate: false };
  }

  private filterOrdersByRequestedIds(
    orders: Awaited<ReturnType<OrdersRepository['findShopifyCustomerOrders']>>,
    requestedIds: string[],
  ) {
    if (!requestedIds || requestedIds.length === 0) {
      return orders;
    }

    const normalizedIds = new Set(
      requestedIds.map((id) => id.trim()).filter(Boolean),
    );
    if (normalizedIds.size === 0) {
      return orders;
    }

    return orders.filter((order) => normalizedIds.has(order.externalOrderId));
  }
}
