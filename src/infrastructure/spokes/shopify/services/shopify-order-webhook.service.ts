import { Injectable, Logger } from '@nestjs/common';
import { VerificationHubService } from '../../../../core/services/verification-hub.service';
import { NormalizedOrder } from '../../../../core/interfaces/order.interface';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { ShopifyWebhookEventsRepository } from '../../../database/repositories/shopify-webhook-events.repository';
import { PhoneService } from '../../../../core/services/phone.service';
import { ShopifyOrderWebhookDto } from '../dto/shopify-webhooks.dto';

interface WebhookAck {
  received: boolean;
  duplicate?: boolean;
}

@Injectable()
export class ShopifyOrderWebhookService {
  private readonly logger = new Logger(ShopifyOrderWebhookService.name);

  constructor(
    private readonly verificationHub: VerificationHubService,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly webhookEventsRepo: ShopifyWebhookEventsRepository,
    private readonly phoneService: PhoneService,
  ) {}

  async handleOrderCreate(
    payload: ShopifyOrderWebhookDto,
    shopDomain: string,
    webhookId: string,
    topic: string,
  ): Promise<WebhookAck> {
    this.logger.log(
      `Received Shopify Order Webhook from ${shopDomain}: ${payload.id}`,
    );

    if (!webhookId) {
      this.logger.warn(
        `Missing X-Shopify-Webhook-Id for order ${payload.id} from ${shopDomain}`,
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
}
