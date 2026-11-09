import type { CommerceOutcomeConnection } from '../commerce/commerce-outcome';
import type { PlatformType } from '../interfaces/commerce-source.interface';
import type { OrderLineItem } from '../interfaces/order.interface';

/**
 * The details a confirmation message shows, as the order's source holds them
 * now. Only these are refreshed on Akeed's copy of the order; its identity,
 * number and stored payload stay as they were captured.
 */
export interface CurrentOrderDetails {
  /** E.164, by the same rules as the source's ingestion. */
  customerPhone: string;
  customerName?: string;
  /** Decimal amount as text. */
  totalPrice: string;
  currency: string;
  paymentMethod?: string;
  lineItems?: OrderLineItem[];
  shippingRegion?: string;
  shippingAddress?: string;
}

/**
 * - `found`: the order as the source holds it now.
 * - `unavailable`: no current details could be read. `order_not_found` is a
 *   definite answer; `order_not_eligible` is an order the source's own
 *   ingestion rules would no longer take (no valid phone, no longer COD);
 *   `order_source_unavailable` is anything worth trying again later.
 */
export type CurrentOrderReadResult =
  | { status: 'found'; order: CurrentOrderDetails }
  | {
      status: 'unavailable';
      code:
        | 'order_source_unavailable'
        | 'order_not_found'
        | 'order_not_eligible';
    };

export interface CurrentOrderReadRequest {
  orgId: string;
  integrationId: string;
  externalOrderId: string;
  /** The order's source, as stored on its integration. */
  connection: CommerceOutcomeConnection;
  /**
   * Akeed's copy of the order. A source with no external store (standalone,
   * manual, import, API) holds its details here and returns them as they are.
   */
  stored: CurrentOrderDetails;
}

/**
 * Reads one order's current details from its source, for an updated
 * confirmation. A read changes nothing at the source and never throws:
 * every failure is an `unavailable` answer, so stale details are never sent
 * as current ones.
 */
export interface CurrentOrderSource {
  readonly platform: PlatformType;
  readCurrentOrder(
    request: CurrentOrderReadRequest,
  ): Promise<CurrentOrderReadResult>;
}

/** DI token for the registered sources, one per platform. */
export const CURRENT_ORDER_SOURCES = Symbol('CURRENT_ORDER_SOURCES');

/** The message details of a normalized order. */
export function currentDetailsOf(order: {
  customerPhone: string;
  customerName?: string | null;
  totalPrice: string;
  currency: string;
  paymentMethod?: string | null;
  lineItems?: OrderLineItem[] | null;
  shippingRegion?: string | null;
  shippingAddress?: string | null;
}): CurrentOrderDetails {
  return {
    customerPhone: order.customerPhone,
    ...(order.customerName ? { customerName: order.customerName } : {}),
    totalPrice: order.totalPrice,
    currency: order.currency,
    ...(order.paymentMethod ? { paymentMethod: order.paymentMethod } : {}),
    ...(order.lineItems?.length ? { lineItems: order.lineItems } : {}),
    ...(order.shippingRegion ? { shippingRegion: order.shippingRegion } : {}),
    ...(order.shippingAddress
      ? { shippingAddress: order.shippingAddress }
      : {}),
  };
}
