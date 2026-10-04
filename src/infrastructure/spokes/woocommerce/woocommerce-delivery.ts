/**
 * What Akeed keeps of a WooCommerce order delivery (US-07-03).
 *
 * The delivered order carries the customer's email, addresses, IP address,
 * line items and whatever other plugins put in `meta_data`. None of that is
 * needed to confirm an order, so the event row holds the delivery's
 * identifiers and only the fields the contract record reads (section 4), plus
 * Akeed's own outcome marker for the echo rule (section 5).
 */
export interface WooCommerceStoredDelivery {
  topic: string;
  /** `X-WC-Webhook-ID` and `X-WC-Webhook-Delivery-ID`: audit only (3.19). */
  webhookId: string | null;
  deliveryId: string | null;
  order: Record<string, unknown>;
}

/** The meta key of Akeed's outcome marker (finding 5.17). */
export const WOOCOMMERCE_OUTCOME_META_KEY = 'akeed_outcome';

const ORDER_TEXT_FIELDS = [
  'number',
  'status',
  'currency',
  'date_created_gmt',
  'date_modified_gmt',
  'total',
  'payment_method',
] as const;
const BILLING_TEXT_FIELDS = [
  'first_name',
  'last_name',
  'phone',
  'country',
] as const;

/** Longest text kept from a field; a longer one is treated as missing. */
const TEXT_MAX_LENGTH = 255;
const HEADER_ID_MAX_LENGTH = 64;
const HEADER_ID_PATTERN = /^[\x21-\x7E]+$/;
const MARKERS_MAX = 20;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickText(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' && value.length <= TEXT_MAX_LENGTH)
      picked[field] = value;
  }
  return picked;
}

function headerId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= HEADER_ID_MAX_LENGTH &&
    HEADER_ID_PATTERN.test(value)
    ? value
    : null;
}

function outcomeMarkers(metaData: unknown): { key: string; value: string }[] {
  if (!Array.isArray(metaData)) return [];
  const markers: { key: string; value: string }[] = [];
  for (const entry of metaData as unknown[]) {
    if (markers.length >= MARKERS_MAX) break;
    if (
      isRecord(entry) &&
      entry.key === WOOCOMMERCE_OUTCOME_META_KEY &&
      typeof entry.value === 'string' &&
      entry.value.length <= TEXT_MAX_LENGTH
    )
      markers.push({ key: WOOCOMMERCE_OUTCOME_META_KEY, value: entry.value });
  }
  return markers;
}

/** The order fields Akeed reads, and nothing else of the delivered object. */
export function projectWooCommerceOrder(
  order: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: typeof order.id === 'number' ? order.id : null,
    ...pickText(order, ORDER_TEXT_FIELDS),
    billing: isRecord(order.billing)
      ? pickText(order.billing, BILLING_TEXT_FIELDS)
      : {},
    meta_data: outcomeMarkers(order.meta_data),
  };
}

export function toStoredWooCommerceDelivery(
  headers: { topic: string; webhookId?: unknown; deliveryId?: unknown },
  order: Record<string, unknown>,
): WooCommerceStoredDelivery {
  return {
    topic: headers.topic,
    webhookId: headerId(headers.webhookId),
    deliveryId: headerId(headers.deliveryId),
    order: projectWooCommerceOrder(order),
  };
}

/** The order of a stored delivery, or null when the row is not one. */
export function readStoredWooCommerceOrder(
  rawPayload: Record<string, unknown>,
): Record<string, unknown> | null {
  return isRecord(rawPayload.order) ? rawPayload.order : null;
}
