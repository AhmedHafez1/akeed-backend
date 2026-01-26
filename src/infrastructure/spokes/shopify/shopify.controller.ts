import {
  Controller,
  Post,
  Body,
  // UseGuards,
  HttpCode,
  Logger,
  Headers,
} from '@nestjs/common';
// import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';
import { VerificationHubService } from '../../../core/services/verification-hub.service';
import { NormalizedOrder } from '../../../core/interfaces/order.interface';
import { IntegrationsRepository } from '../../database/repositories/integrations.repository';
import type { ShopifyOrderPayload } from './models/shopify-order-payload';
import type { ShopifyAppUninstalledPayload } from './models/shopify-app-uninstalled-payload';

@Controller('webhooks/shopify')
// @UseGuards(ShopifyHmacGuard)
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(
    private readonly verificationHub: VerificationHubService,
    private readonly integrationsRepo: IntegrationsRepository,
  ) {}

  @Post('orders-create')
  @HttpCode(200)
  async handleOrderCreate(
    @Body() payload: ShopifyOrderPayload,
    @Headers('x-shopify-shop-domain') shopDomain: string,
  ) {
    this.logger.log(
      `Received Shopify Order Webhook from ${shopDomain}: ${payload.id}`,
    );

    // Resolve orgId via domain integration mapping
    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );
    const orgId = integration?.orgId;

    if (!orgId) {
      this.logger.warn(
        `Skipping order ${payload.id}: No integration/org found for domain ${shopDomain}`,
      );
      return { received: true };
    }

    const normalizedOrder = this.mapToHubOrder(payload, orgId, integration.id);

    await this.verificationHub.handleNewOrder(normalizedOrder);

    return { received: true };
  }

  private mapToHubOrder(
    payload: ShopifyOrderPayload,
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
      totalPrice: payload.total_price,
      currency: payload.currency,
      rawPayload: payload,
    };
  }

  @Post('uninstalled')
  @HttpCode(200)
  async handleAppUninstalled(
    @Body() payload: ShopifyAppUninstalledPayload,
    @Headers('x-shopify-shop-domain') shopDomain: string,
  ) {
    this.logger.log(
      `Received Shopify App Uninstalled Webhook from ${shopDomain}: ${payload.id}`,
    );

    // Resolve orgId via domain integration mapping
    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );
    const orgId = integration?.orgId;

    if (!orgId) {
      this.logger.warn(
        `Skipping app uninstalled: No integration/org found for domain ${shopDomain}`,
      );
      return { received: true };
    }

    await this.integrationsRepo.deleteByOrgId(orgId);

    return { received: true };
  }
}
