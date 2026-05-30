import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import { PhoneService } from '../../../../shared/services/phone.service';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { IntegrationMonthlyUsageRepository } from '../../../database/repositories/integration-monthly-usage.repository';
import { MembershipsRepository } from '../../../database/repositories/memberships.repository';
import { OrdersRepository } from '../../../database/repositories/orders.repository';
import { OrganizationsRepository } from '../../../database/repositories/organizations.repository';
import { WebhookEventsRepository } from '../../../database/repositories/webhook-events.repository';
import { VerificationsRepository } from '../../../database/repositories/verifications.repository';
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

    const rawPhone = payload.customer?.phone?.trim();
    if (!rawPhone) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleCustomerDataRequest.missingPhone',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const normalizedPhone = this.normalizePhone(rawPhone);
    const orders = await this.fetchOrdersByPhone(
      orgId,
      rawPhone,
      normalizedPhone,
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

    const { integration, orgId, isDuplicate } =
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

    const rawPhone = payload.customer?.phone?.trim();
    if (!rawPhone) {
      this.logger.warn(
        buildBackendLog('ShopifyGdprWebhookService', {
          action: 'handleCustomerRedact.missingPhone',
          outcome: 'skipped',
          shopDomain,
        }),
      );
      return { received: true };
    }

    const normalizedPhone = this.normalizePhone(rawPhone);
    const orders = await this.fetchOrdersByPhone(
      orgId,
      rawPhone,
      normalizedPhone,
    );
    const orderIds = orders.map((order) => order.id);

    const redactedOrders =
      await this.ordersRepo.redactCustomerByOrderIds(orderIds);
    const clearedVerifications =
      await this.verificationsRepo.clearMetadataByOrderIds(orderIds);

    this.logger.log(
      buildBackendLog('ShopifyGdprWebhookService', {
        action: 'handleCustomerRedact.completed',
        outcome: 'success',
        shopDomain,
        redactedOrders,
        clearedVerifications,
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
    }

    return { integration, orgId, isDuplicate: false };
  }

  private normalizePhone(phone: string): string {
    try {
      return this.phoneService.standardize(phone);
    } catch {
      return phone.trim();
    }
  }

  private async fetchOrdersByPhone(
    orgId: string,
    rawPhone: string,
    normalizedPhone: string,
  ): Promise<
    Array<Awaited<ReturnType<OrdersRepository['findByOrgAndPhone']>>[number]>
  > {
    const normalized = normalizedPhone.trim();
    const raw = rawPhone.trim();

    if (normalized && normalized !== raw) {
      const [normalizedOrders, rawOrders] = await Promise.all([
        this.ordersRepo.findByOrgAndPhone(orgId, normalized),
        this.ordersRepo.findByOrgAndPhone(orgId, raw),
      ]);

      const merged = new Map<string, (typeof normalizedOrders)[number]>();
      for (const order of normalizedOrders) {
        merged.set(order.id, order);
      }
      for (const order of rawOrders) {
        merged.set(order.id, order);
      }
      return Array.from(merged.values());
    }

    return this.ordersRepo.findByOrgAndPhone(orgId, raw);
  }

  private filterOrdersByRequestedIds(
    orders: Array<
      Awaited<ReturnType<OrdersRepository['findByOrgAndPhone']>>[number]
    >,
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
