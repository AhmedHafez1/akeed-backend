import { Injectable, Logger } from '@nestjs/common';
import { PhoneService } from '../../../../core/services/phone.service';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { IntegrationMonthlyUsageRepository } from '../../../database/repositories/integration-monthly-usage.repository';
import { MembershipsRepository } from '../../../database/repositories/memberships.repository';
import { OrdersRepository } from '../../../database/repositories/orders.repository';
import { OrganizationsRepository } from '../../../database/repositories/organizations.repository';
import { ShopifyWebhookEventsRepository } from '../../../database/repositories/shopify-webhook-events.repository';
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
    private readonly webhookEventsRepo: ShopifyWebhookEventsRepository,
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
      `Received Shopify GDPR Data Request from ${shopDomain}: customer=${customerId}`,
    );

    const { integration, orgId, isDuplicate } =
      await this.resolveWebhookContext({
        shopDomain,
        webhookId,
        topic,
        logLabel: 'GDPR data request',
      });

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    if (!integration || !orgId) {
      this.logger.warn(
        `GDPR data request received but no integration/org found for ${shopDomain}`,
      );
      return { received: true };
    }

    const rawPhone = payload.customer?.phone?.trim();
    if (!rawPhone) {
      this.logger.warn(
        `GDPR data request missing customer phone for shop ${shopDomain}`,
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
      `GDPR data request export prepared for shop ${shopDomain}: orders=${exportPayload.length}`,
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
      `Received Shopify GDPR Customer Redact from ${shopDomain}: customer=${customerId}`,
    );

    const { integration, orgId, isDuplicate } =
      await this.resolveWebhookContext({
        shopDomain,
        webhookId,
        topic,
        logLabel: 'GDPR customer redact',
      });

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    if (!integration || !orgId) {
      this.logger.warn(
        `GDPR customer redact received but no integration/org found for ${shopDomain}`,
      );
      return { received: true };
    }

    const rawPhone = payload.customer?.phone?.trim();
    if (!rawPhone) {
      this.logger.warn(
        `GDPR customer redact missing customer phone for shop ${shopDomain}`,
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
      `GDPR customer redact completed for shop ${shopDomain}: orders=${redactedOrders}, verifications=${clearedVerifications}`,
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
      `Received Shopify GDPR Shop Redact from ${resolvedShopDomain}`,
    );

    const { orgId, isDuplicate } = await this.resolveWebhookContext({
      shopDomain,
      webhookId,
      topic,
      logLabel: 'GDPR shop redact',
    });

    if (isDuplicate) {
      return { received: true, duplicate: true };
    }

    if (!orgId) {
      this.logger.warn(
        `GDPR shop redact received but no integration/org found for ${shopDomain}`,
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
      `GDPR shop redact completed for org ${orgId}: webhooks=${webhookEventsDeleted}, usage=${usageDeleted}, verifications=${verificationsDeleted}, orders=${ordersDeleted}, integrations=${integrationsDeleted}, memberships=${membershipsDeleted}, organizations=${organizationsDeleted}`,
    );

    return { received: true };
  }

  private async resolveWebhookContext(params: {
    shopDomain: string;
    webhookId: string;
    topic: string;
    logLabel: string;
  }): Promise<{
    integration?: Awaited<
      ReturnType<IntegrationsRepository['findByPlatformDomain']>
    >;
    orgId?: string;
    isDuplicate: boolean;
  }> {
    if (!params.webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for ${params.logLabel} from ${params.shopDomain}`,
      );
    }

    const integration = await this.integrationsRepo.findByPlatformDomain(
      params.shopDomain,
      'shopify',
    );
    const orgId = integration?.orgId;

    if (params.webhookId) {
      const isNew = await this.webhookEventsRepo.recordIfNew({
        webhookId: params.webhookId,
        topic: params.topic,
        shopDomain: params.shopDomain,
        orgId,
        integrationId: integration?.id,
      });

      if (!isNew) {
        this.logger.warn(
          `Duplicate Shopify ${params.logLabel} ${params.webhookId} ignored for shop ${params.shopDomain}`,
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
