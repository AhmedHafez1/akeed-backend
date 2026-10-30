import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import { PhoneService } from '../../../../shared/services/phone.service';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { IntegrationMonthlyUsageRepository } from '../../../database/repositories/integration-monthly-usage.repository';
import { MembershipsRepository } from '../../../database/repositories/memberships.repository';
import {
  hasShopifyCustomerKeys,
  OrdersRepository,
  type ShopifyCustomerKeys,
} from '../../../database/repositories/orders.repository';
import { OrganizationsRepository } from '../../../database/repositories/organizations.repository';
import { WebhookEventsRepository } from '../../../database/repositories/webhook-events.repository';
import { VerificationsRepository } from '../../../database/repositories/verifications.repository';
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
    private readonly verificationsRepo: VerificationsRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly integrationUsageRepo: IntegrationMonthlyUsageRepository,
    private readonly membershipsRepo: MembershipsRepository,
    private readonly organizationsRepo: OrganizationsRepository,
    private readonly webhookEventsRepo: WebhookEventsRepository,
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

    const { orgId, isDuplicate } = await this.resolveWebhookContext({
      shopDomain,
      webhookId,
      topic,
      logLabel: 'GDPR shop redact',
      rawPayload: payload as unknown as Record<string, unknown>,
    });

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    if (!orgId) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleShopRedact.noIntegration',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const webhookEventsDeleted =
      await this.webhookEventsRepo.deleteByOrgId(orgId);
    const usageDeleted = await this.integrationUsageRepo.deleteByOrgId(orgId);
    const verificationsDeleted =
      await this.verificationsRepo.deleteByOrgId(orgId);
    const ordersDeleted = await this.ordersRepo.deleteByOrgId(orgId);
    const integrationsDeleted =
      await this.integrationsRepo.deleteByOrgId(orgId);
    const membershipsDeleted = await this.membershipsRepo.deleteByOrgId(orgId);
    const organizationsDeleted = await this.organizationsRepo.deleteById(orgId);

    this.logger.log(
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleShopRedact.completed',
        outcome: 'success',
        orgId,
        webhookEventsDeleted,
        usageDeleted,
        verificationsDeleted,
        ordersDeleted,
        integrationsDeleted,
        membershipsDeleted,
        organizationsDeleted,
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

    const integration = await this.integrationsRepo.findByPlatformDomain(
      params.shopDomain,
      'shopify',
    );
    const orgId = integration?.orgId;

    if (params.webhookId) {
      const insertedWebhookRecord = await this.webhookEventsRepo.insertIfNew({
        platform: 'shopify',
        jobType: params.topic || params.logLabel,
        idempotencyKey: params.webhookId,
        storeDomain: params.shopDomain,
        orgId: integration?.orgId ?? null,
        integrationId: integration?.id ?? null,
        rawPayload: params.rawPayload,
      });

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

    return { integration, orgId, isDuplicate: false };
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
