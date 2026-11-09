import { Injectable, Logger } from '@nestjs/common';
import type { PlatformType } from '../../../../shared/interfaces/commerce-source.interface';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import {
  currentDetailsOf,
  type CurrentOrderReadRequest,
  type CurrentOrderReadResult,
  type CurrentOrderSource,
} from '../../../../shared/ports/current-order-source.port';
import { ShopifyApiService } from './shopify-api.service';
import type { ShopifyCurrentOrder } from './shopify-api.service.helpers';
import { ShopifyOrderNormalizer } from './shopify-order.normalizer';

function text(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Restates a GraphQL order in the fields of the REST order the webhook
 * normalizer reads, so the current details follow exactly the rules the
 * order was taken in by: the same phone candidates in the same order, the
 * same item and address handling. Quantities and the total are the current
 * ones, after any order edit; a line removed by an edit has quantity 0 and
 * is left out.
 */
export function toShopifyWebhookShape(
  externalOrderId: string,
  order: ShopifyCurrentOrder,
): Record<string, unknown> {
  const country = (address?: { countryCodeV2?: string | null } | null) =>
    text(address?.countryCodeV2);
  return {
    id: externalOrderId,
    phone: text(order.phone),
    customer: order.customer
      ? {
          first_name: text(order.customer.firstName),
          last_name: text(order.customer.lastName),
          phone: text(order.customer.phone),
          default_address: order.customer.defaultAddress
            ? {
                phone: text(order.customer.defaultAddress.phone),
                country_code: country(order.customer.defaultAddress),
              }
            : undefined,
        }
      : undefined,
    billing_address: order.billingAddress
      ? {
          phone: text(order.billingAddress.phone),
          country_code: country(order.billingAddress),
        }
      : undefined,
    shipping_address: order.shippingAddress
      ? {
          phone: text(order.shippingAddress.phone),
          country_code: country(order.shippingAddress),
          address1: order.shippingAddress.address1 ?? null,
          address2: order.shippingAddress.address2 ?? null,
          city: order.shippingAddress.city ?? null,
          province: order.shippingAddress.province ?? null,
        }
      : undefined,
    line_items: (order.lineItems?.nodes ?? [])
      .filter(
        (item): item is NonNullable<typeof item> =>
          item !== null && (item.currentQuantity ?? 0) > 0,
      )
      .map((item) => ({
        title: item.title ?? undefined,
        variant_title: item.variantTitle ?? undefined,
        quantity: item.currentQuantity,
        price: item.originalUnitPriceSet?.shopMoney?.amount ?? undefined,
      })),
    total_price: order.currentTotalPriceSet?.shopMoney?.amount ?? undefined,
    currency: order.currentTotalPriceSet?.shopMoney?.currencyCode ?? undefined,
    payment_gateway_names: order.paymentGatewayNames ?? [],
  };
}

/**
 * A Shopify order's current details, read through the Admin GraphQL API
 * with the store's own token. No scope beyond what ingestion already uses.
 */
@Injectable()
export class ShopifyCurrentOrderSource implements CurrentOrderSource {
  readonly platform: PlatformType = 'shopify';

  private readonly logger = new Logger(ShopifyCurrentOrderSource.name);

  constructor(
    private readonly api: ShopifyApiService,
    private readonly normalizer: ShopifyOrderNormalizer,
  ) {}

  async readCurrentOrder(
    request: CurrentOrderReadRequest,
  ): Promise<CurrentOrderReadResult> {
    try {
      if (!request.connection.isActive || !request.connection.accessToken)
        return this.unavailable(
          request,
          'order_source_unavailable',
          'connection',
        );
      const order = await this.api.getCurrentOrder(
        request.connection,
        request.externalOrderId,
      );
      if (!order)
        return this.unavailable(request, 'order_not_found', 'missing');
      const normalized = this.normalizer.normalizeOrder(
        toShopifyWebhookShape(request.externalOrderId, order),
        request.integrationId,
        request.orgId,
      );
      if (!normalized || !normalized.totalPrice || !normalized.currency)
        return this.unavailable(request, 'order_not_eligible', 'normalize');
      return { status: 'found', order: currentDetailsOf(normalized) };
    } catch (error) {
      this.logger.warn(
        buildBackendLog(ShopifyCurrentOrderSource.name, {
          action: 'shopify-current-order-read',
          outcome: 'failure',
          orgId: request.orgId,
          integrationId: request.integrationId,
          ...normalizeError(error),
        }),
      );
      return { status: 'unavailable', code: 'order_source_unavailable' };
    }
  }

  private unavailable(
    request: CurrentOrderReadRequest,
    code: Extract<CurrentOrderReadResult, { status: 'unavailable' }>['code'],
    reason: string,
  ): CurrentOrderReadResult {
    this.logger.warn(
      buildBackendLog(ShopifyCurrentOrderSource.name, {
        action: 'shopify-current-order-read',
        outcome: 'skipped',
        orgId: request.orgId,
        integrationId: request.integrationId,
        reason,
        code,
      }),
    );
    return { status: 'unavailable', code };
  }
}
