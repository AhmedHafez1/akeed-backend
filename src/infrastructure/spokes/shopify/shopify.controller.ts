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
import {
  ShopifyAppSubscriptionWebhookDto,
  ShopifyAppUninstalledDto,
  ShopifyOrderWebhookDto,
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

    await this.verificationHub.handleNewOrder(normalizedOrder);

    return { received: true };
  }

  private mapToHubOrder(
    payload: ShopifyOrderWebhookDto,
    orgId: string,
    integrationId: string,
  ): NormalizedOrder {
    // Attempt to find a phone number from various fields
    const phone =
      payload.phone ||
      payload.customer?.phone ||
      payload.customer?.default_address?.phone ||
      payload.billing_address?.phone ||
      payload.shipping_address?.phone;

    return {
      orgId,
      externalOrderId: String(payload.id),
      integrationId: integrationId,
      orderNumber: String(payload.order_number),
      customerPhone: phone || '', // Ideally this should be validated/formatted but basic extraction for now
      customerName: payload.customer
        ? `${payload.customer.first_name} ${payload.customer.last_name}`.trim()
        : 'Guest',
      totalPrice: payload.total_price ?? '',
      currency: payload.currency ?? '',
      rawPayload: payload,
    };
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
