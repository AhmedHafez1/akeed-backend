import { Injectable, Logger } from '@nestjs/common';
import { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import { WebhookOrderNormalizer } from '../interfaces/webhook-normalizer.interface';
import { PhoneService } from '../../../shared/services/phone.service';
import { PlatformType } from '../webhook-queue.constants';

/**
 * Converts a raw Shopify order webhook payload into a NormalizedOrder.
 *
 * Mirrors the logic previously embedded in ShopifyOrderWebhookService,
 * but extracted as a pure, stateless normalizer for the job queue pipeline.
 */
@Injectable()
export class ShopifyOrderNormalizer implements WebhookOrderNormalizer {
  readonly platform: PlatformType = 'shopify';

  private readonly logger = new Logger(ShopifyOrderNormalizer.name);

  constructor(private readonly phoneService: PhoneService) {}

  normalizeOrder(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): NormalizedOrder | null {
    const payload = rawPayload as unknown as ShopifyRawOrder;

    const { phone, countryCode } = this.resolvePhoneDetails(payload);
    const standardizedPhone = phone
      ? this.phoneService.standardize(phone, countryCode)
      : '';

    if (!standardizedPhone) {
      this.logger.warn(
        `Cannot normalise Shopify order ${payload.id}: no valid phone found`,
      );
      return null;
    }

    const paymentMethod = this.resolvePaymentMethod(payload);

    return {
      orgId,
      integrationId,
      externalOrderId: String(payload.id),
      orderNumber: String(payload.order_number ?? ''),
      customerPhone: standardizedPhone,
      customerName: payload.customer
        ? `${payload.customer.first_name ?? ''} ${payload.customer.last_name ?? ''}`.trim()
        : 'Guest',
      totalPrice: payload.total_price ?? '',
      currency: payload.currency ?? '',
      paymentMethod,
      rawPayload,
    };
  }

  private resolvePhoneDetails(payload: ShopifyRawOrder): {
    phone?: string;
    countryCode?: string;
  } {
    const candidates = [
      { phone: payload.phone, countryCode: payload.countryCode },
      {
        phone: payload.customer?.phone,
        countryCode: payload.customer?.default_address?.country_code,
      },
      {
        phone: payload.customer?.default_address?.phone,
        countryCode: payload.customer?.default_address?.country_code,
      },
      {
        phone: payload.billing_address?.phone,
        countryCode: payload.billing_address?.country_code,
      },
      {
        phone: payload.shipping_address?.phone,
        countryCode: payload.shipping_address?.country_code,
      },
    ];

    return candidates.find((c) => c.phone) ?? {};
  }

  private resolvePaymentMethod(payload: ShopifyRawOrder): string {
    const gatewayNames =
      payload.payment_gateway_names
        ?.map((n: string) => n.trim())
        .filter(Boolean) ?? [];

    if (gatewayNames.length > 0) return gatewayNames.join(', ');
    return payload.gateway?.trim() ?? '';
  }
}

/** Minimal type for the raw Shopify order — avoids importing the DTO in the normalizer. */
interface ShopifyRawOrder {
  id: string | number;
  order_number?: string | number;
  phone?: string;
  countryCode?: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    default_address?: { phone?: string; country_code?: string };
  };
  billing_address?: { phone?: string; country_code?: string };
  shipping_address?: { phone?: string; country_code?: string };
  total_price?: string;
  currency?: string;
  gateway?: string;
  payment_gateway_names?: string[];
}
