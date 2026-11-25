import { Injectable } from '@nestjs/common';
import type {
  ShippingDetection,
  ShippingDetectionSettings,
  ShippingEventSource,
  ShippingOrderRef,
} from '../../../../modules/shipping-notifications/shipping-event-source';
import {
  detectShopifyShipping,
  readShopifyOrderRef,
} from './shopify-shipping-event.mapper';

/** Reads Shopify `orders/updated` events for shipping notifications. */
@Injectable()
export class ShopifyShippingEventSource implements ShippingEventSource {
  readonly platform = 'shopify' as const;

  readOrderRef(rawPayload: Record<string, unknown>): ShippingOrderRef | null {
    return readShopifyOrderRef(rawPayload);
  }

  detect(
    rawPayload: Record<string, unknown>,
    settings: ShippingDetectionSettings,
  ): ShippingDetection | null {
    return detectShopifyShipping(rawPayload, settings);
  }
}
