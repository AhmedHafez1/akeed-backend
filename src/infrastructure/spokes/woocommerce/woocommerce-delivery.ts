import {
  toOrderLineItems,
  type OrderLineItemInput,
} from '../../../shared/commerce/order-line-items';
import { ORDER_LINE_ITEMS_MAX } from '../../../shared/interfaces/order.interface';

/**
 * What Akeed keeps of a WooCommerce order delivery.
 *
 * The delivered order carries the customer's email, billing address, IP
 * address and user agent, the order key, payment details and whatever other
 * plugins put in `meta_data`. None of that is kept. The event row holds the
 * delivery's identifiers, the fields ingestion reads, Akeed's own outcome
 * marker for the echo rule, and what the order details show the merchant:
 * the shipping region and street lines, and at most 50 product lines of
 * name, quantity, unit price and a few plain-text options.
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
/** The delivery address only; the billing address is never shown as one. */
const SHIPPING_TEXT_FIELDS = [
  'state',
  'city',
  'address_1',
  'address_2',
] as const;

/** Longest text kept from a field; a longer one is treated as missing. */
const TEXT_MAX_LENGTH = 255;
const HEADER_ID_MAX_LENGTH = 64;
const HEADER_ID_PATTERN = /^[\x21-\x7E]+$/;
const MARKERS_MAX = 20;
/** Meta entries read per product line when looking for its options. */
const LINE_META_SCAN_MAX = 20;
/** Text that looks like markup or an entity is not shown as plain text. */
const MARKUP_PATTERN = /[<>]|&(?:#\d+|#x[\da-f]+|[a-z]+\d*);/i;

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

/** A string or number fit to show as is, else null. */
function plainText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const line = value.trim();
  return line && line.length <= TEXT_MAX_LENGTH && !MARKUP_PATTERN.test(line)
    ? line
    : null;
}

/**
 * A product line's options, from its public scalar meta: a variation
 * attribute or a plugin's visible choice. Keys starting with `_` are private,
 * and nested or markup values are left out. The readable `display_key` and
 * `display_value` win when they are plain text.
 */
function lineOptions(metaData: unknown): { name: string; value: string }[] {
  if (!Array.isArray(metaData)) return [];
  const options: { name: string; value: string }[] = [];
  for (const entry of (metaData as unknown[]).slice(0, LINE_META_SCAN_MAX)) {
    if (!isRecord(entry) || typeof entry.key !== 'string') continue;
    if (!entry.key || entry.key.startsWith('_')) continue;
    const name = plainText(entry.display_key) ?? plainText(entry.key);
    const value = plainText(entry.display_value) ?? plainText(entry.value);
    if (name && value) options.push({ name, value });
  }
  return options;
}

/**
 * The product lines, through the shared order-line rules: bounded text, a
 * whole quantity, a decimal unit price or null, and at most
 * `ORDER_LINE_ITEMS_MAX` lines. `price` is WooCommerce's unit price; a line
 * total is never put in its place.
 */
function projectLineItems(lineItems: unknown): Record<string, unknown>[] {
  if (!Array.isArray(lineItems)) return [];
  const inputs: OrderLineItemInput[] = [];
  for (const item of lineItems as unknown[]) {
    if (inputs.length === ORDER_LINE_ITEMS_MAX) break;
    // A nameless line would be dropped by the shared rules; skip it here so
    // it does not use up one of the kept lines.
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim())
      continue;
    inputs.push({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.price,
      options: lineOptions(item.meta_data),
    });
  }
  return toOrderLineItems(inputs).map((line) => ({
    name: line.name,
    quantity: line.quantity,
    price: line.unitPrice,
    options: line.options,
  }));
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
    shipping: isRecord(order.shipping)
      ? pickText(order.shipping, SHIPPING_TEXT_FIELDS)
      : {},
    line_items: projectLineItems(order.line_items),
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
