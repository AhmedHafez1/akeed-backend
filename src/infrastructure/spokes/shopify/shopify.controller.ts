import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';
import { VerificationHubService } from '../../../core/services/verification-hub.service';
import { NormalizedOrder } from '../../../core/interfaces/order.interface';
import { IntegrationsRepository } from '../../database/repositories/integrations.repository';
import { ShopifyWebhookEventsRepository } from '../../database/repositories/shopify-webhook-events.repository';
import { PhoneService } from '../../../core/services/phone.service';
import {
  ShopifyAppSubscriptionWebhookDto,
  ShopifyAppUninstalledDto,
  ShopifyCustomersDataRequestDto,
  ShopifyCustomersRedactDto,
  ShopifyOrderWebhookDto,
  ShopifyShopRedactDto,
} from './dto/shopify-webhooks.dto';

@Controller('webhooks/shopify')
@UseGuards(ShopifyHmacGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: false,
  }),
)
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(
    private readonly verificationHub: VerificationHubService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly webhookEventsRepo: ShopifyWebhookEventsRepository,
    private readonly phoneService: PhoneService,
  ) {}

  @Post('orders-create')
  @HttpCode(200)
  async handleOrderCreate(
    @Body() payload: ShopifyOrderWebhookDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    this.logger.log(
      `Received Shopify Order Webhook from ${shopDomain}: ${payload.id}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for order ${payload.id} from ${shopDomain}`,
      );
    }

    // Resolve orgId via domain integration mapping
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
        `Skipping order ${payload.id}: No integration/org found for domain ${shopDomain}`,
      );
      return { received: true };
    }

    if (!integration || this.isIntegrationBillingBlocked(integration)) {
      this.logger.warn(
        `Skipping order ${payload.id}: Billing is not active for shop ${shopDomain} (status=${integration?.billingStatus ?? 'unknown'})`,
      );
      return { received: true };
    }

    const normalizedOrder = this.mapToHubOrder(payload, orgId, integration.id);

    await this.verificationHub.handleNewOrder(normalizedOrder, integration);

    return { received: true };
  }

  private mapToHubOrder(
    payload: ShopifyOrderWebhookDto,
    orgId: string,
    integrationId: string,
  ): NormalizedOrder {
    const { phone, countryCode } = this.resolvePhoneDetails(payload);
    const standardizedPhone = phone
      ? this.phoneService.standardize(phone, countryCode)
      : '';
    const paymentMethod = this.resolvePaymentMethod(payload);

    return {
      orgId,
      externalOrderId: String(payload.id),
      integrationId: integrationId,
      orderNumber: String(payload.order_number),
      customerPhone: standardizedPhone,
      customerName: payload.customer
        ? `${payload.customer.first_name} ${payload.customer.last_name}`.trim()
        : 'Guest',
      totalPrice: payload.total_price ?? '',
      currency: payload.currency ?? '',
      paymentMethod,
      rawPayload: payload,
    };
  }

  private resolvePhoneDetails(payload: ShopifyOrderWebhookDto): {
    phone?: string;
    countryCode?: string;
  } {
    const { phone, countryCode, customer, billing_address, shipping_address } =
      payload;
    const { phone: customerPhone, default_address } = customer ?? {};
    const { phone: defaultPhone, country_code: defaultCountryCode } =
      default_address ?? {};
    const { phone: billingPhone, country_code: billingCountryCode } =
      billing_address ?? {};
    const { phone: shippingPhone, country_code: shippingCountryCode } =
      shipping_address ?? {};

    const candidates = [
      { phone, countryCode },
      { phone: customerPhone, countryCode: defaultCountryCode },
      { phone: defaultPhone, countryCode: defaultCountryCode },
      { phone: billingPhone, countryCode: billingCountryCode },
      { phone: shippingPhone, countryCode: shippingCountryCode },
    ];

    return candidates.find((candidate) => candidate.phone) ?? {};
  }

  private resolvePaymentMethod(payload: ShopifyOrderWebhookDto): string {
    const gatewayNames =
      payload.payment_gateway_names
        ?.map((gatewayName) => gatewayName.trim())
        .filter(Boolean) ?? [];
    if (gatewayNames.length > 0) {
      return gatewayNames.join(', ');
    }

    return payload.gateway?.trim() ?? '';
  }

  @Post('uninstalled')
  @HttpCode(200)
  async handleAppUninstalled(
    @Body() payload: ShopifyAppUninstalledDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    this.logger.log(
      `Received Shopify App Uninstalled Webhook from ${shopDomain}: ${payload.id}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for app uninstall from ${shopDomain}`,
      );
    }

    // Resolve orgId via domain integration mapping
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

  @Post(['app-subscriptions-update', 'app-subscriptions/update'])
  @HttpCode(200)
  async handleAppSubscriptionUpdate(
    @Body() payload: ShopifyAppSubscriptionWebhookDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
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

  @Post('customers/data_request')
  @HttpCode(200)
  async handleCustomerDataRequest(
    @Body() payload: ShopifyCustomersDataRequestDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
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

  @Post('customers/redact')
  @HttpCode(200)
  async handleCustomerRedact(
    @Body() payload: ShopifyCustomersRedactDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
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

  @Post('shop/redact')
  @HttpCode(200)
  async handleShopRedact(
    @Body() payload: ShopifyShopRedactDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
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

  private isIntegrationBillingBlocked(
    integration: Awaited<
      ReturnType<IntegrationsRepository['findByPlatformDomain']>
    >,
  ): boolean {
    if (!integration) {
      return true;
    }

    if (integration.isActive === false) {
      return true;
    }

    return this.isBlockedBillingStatus(integration.billingStatus ?? undefined);
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
