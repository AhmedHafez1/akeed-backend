import { Injectable, Logger } from '@nestjs/common';
import { buildBackendLog } from '../../../../shared/logging/backend-log.util';
import {
  NormalizedOrder,
  type OrderLineItem,
} from '../../../../shared/interfaces/order.interface';
import { WebhookOrderNormalizer } from '../../../../modules/webhook-queue/interfaces/webhook-normalizer.interface';
import { PhoneService } from '../../../../shared/services/phone.service';
import type { PlatformType } from '../../../../shared/interfaces/commerce-source.interface';
import { toOrderLineItems } from '../../../../shared/commerce/order-line-items';
import {
  appendPaymentSignal,
  classifyCodStatus,
} from '../../../../shared/commerce/payment-signals';
import { collectShopifyGatewaySignals } from './shopify-payment-signals';

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
        buildBackendLog('ShopifyOrderNormalizer', {
          action: 'normalizeOrder',
          outcome: 'skipped',
          externalOrderId: String(payload.id),
          reason: 'no_valid_phone',
        }),
      );
      return null;
    }

    const paymentMethod = this.resolvePaymentMethod(payload);
    const paymentSignals = this.collectPaymentSignals(payload, paymentMethod);
    const lineItems = this.resolveLineItems(payload);

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
      paymentSignals,
      codStatus: classifyCodStatus(paymentSignals),
      ...(lineItems.length ? { lineItems } : {}),
      ...this.resolveShipping(payload),
      rawPayload,
    };
  }

  private resolveLineItems(payload: ShopifyRawOrder): OrderLineItem[] {
    return toOrderLineItems(
      (Array.isArray(payload.line_items) ? payload.line_items : [])
        .filter((item) => item !== null && typeof item === 'object')
        .map((item) => ({
          name: item.title ?? item.name,
          quantity: item.quantity,
          unitPrice: item.price,
          // A product without variants reports this placeholder title.
          options:
            typeof item.variant_title === 'string' &&
            item.variant_title !== 'Default Title'
              ? [{ value: item.variant_title }]
              : [],
        })),
    );
  }

  /**
   * Where the order ships: the governorate (`province`), else the city, and
   * the street lines. Shopify omits these for an app without access to
   * protected customer data, and then both are absent.
   */
  private resolveShipping(payload: ShopifyRawOrder): {
    shippingRegion?: string;
    shippingAddress?: string;
  } {
    const address = payload.shipping_address;
    const line = (value: unknown) =>
      typeof value === 'string' ? value.trim() : '';
    const region = line(address?.province) || line(address?.city);
    const street = [line(address?.address1), line(address?.address2)]
      .filter(Boolean)
      .join(', ');
    return {
      ...(region ? { shippingRegion: region } : {}),
      ...(street ? { shippingAddress: street } : {}),
    };
  }

  private collectPaymentSignals(
    payload: ShopifyRawOrder,
    paymentMethod: string,
  ): string[] {
    const signals: string[] = [];
    appendPaymentSignal(signals, paymentMethod);
    for (const gatewaySignal of collectShopifyGatewaySignals(payload)) {
      appendPaymentSignal(signals, gatewaySignal);
    }
    return signals;
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
  shipping_address?: {
    phone?: string;
    country_code?: string;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
  };
  line_items?: Array<{
    title?: unknown;
    name?: unknown;
    variant_title?: unknown;
    quantity?: unknown;
    price?: unknown;
  } | null>;
  total_price?: string;
  currency?: string;
  gateway?: string;
  payment_gateway_names?: string[];
  transactions?: Array<{ gateway?: string } | null>;
}
