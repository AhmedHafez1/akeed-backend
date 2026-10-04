import { WebhookJobType } from '../../../modules/webhook-queue/webhook-queue.constants';

/**
 * The ingestion rule (US-07-01 contract record, section 4). One pure policy
 * decides what a delivery is: the webhook service uses it to pick the
 * idempotency key, and the normalizer uses it for the recorded reason.
 */

/** The ID of the core Cash on Delivery gateway (finding 4.8). */
export const WOOCOMMERCE_COD_PAYMENT_METHOD = 'cod';

/** The statuses a placed order carries (finding 4.12). */
export const WOOCOMMERCE_PLACED_STATUSES: ReadonlySet<string> = new Set([
  'processing',
  'on-hold',
]);

/** Why a delivery starts nothing. Stable codes, recorded on the event. */
export type WooCommerceStartSkipReason =
  | 'order_predates_connection'
  | 'order_not_placed'
  | 'non_cod_payment_method'
  | 'missing_payment_signal';

export type WooCommerceStartDecision =
  | { start: true }
  | { start: false; reason: WooCommerceStartSkipReason };

/** The order fields the rule reads; everything is untrusted. */
export interface WooCommerceOrderFacts {
  status?: unknown;
  payment_method?: unknown;
  date_created_gmt?: unknown;
  date_modified_gmt?: unknown;
}

export type WooCommerceDeliveryRoute =
  | { route: 'create'; jobType: WebhookJobType; idempotencyKey: string }
  | { route: 'update'; jobType: WebhookJobType; idempotencyKey: string }
  | {
      route: 'skipped';
      jobType: WebhookJobType;
      idempotencyKey: string;
      reason: WooCommerceStartSkipReason;
    };

const GMT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const KEY_PART_MAX_LENGTH = 64;
/** Printable ASCII without spaces: a status or a date, never free text. */
const KEY_PART_PATTERN = /^[\x21-\x7E]+$/;
const INVALID_KEY_PART = 'invalid';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A REST date "as GMT": `YYYY-MM-DDTHH:MM:SS` with no zone suffix (finding
 * 4.4), read as UTC. Anything else is unreadable.
 */
export function parseWooCommerceGmtDate(value: unknown): number | null {
  if (typeof value !== 'string' || !GMT_DATE_PATTERN.test(value)) return null;
  const time = Date.parse(`${value}Z`);
  return Number.isNaN(time) ? null : time;
}

/** Resource IDs are integers (finding 4.3); written as decimal text. */
export function readWooCommerceOrderId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

export function isWooCommerceCashOnDelivery(paymentMethod: unknown): boolean {
  return text(paymentMethod) === WOOCOMMERCE_COD_PAYMENT_METHOD;
}

/**
 * Whether a delivery starts a verification, on either topic. The reasons are
 * evaluated in the record's order.
 *
 * `date_created_gmt` has no fraction, so the connection moment is compared at
 * the same resolution: an order created in the second the source connected is
 * not earlier than it. A missing or unreadable date counts as earlier.
 */
export function evaluateWooCommerceStart(
  order: WooCommerceOrderFacts,
  connectedAt: string | Date,
): WooCommerceStartDecision {
  const createdAt = parseWooCommerceGmtDate(order.date_created_gmt);
  const connectedSecond =
    Math.floor(new Date(connectedAt).getTime() / 1000) * 1000;
  if (createdAt === null || !(createdAt >= connectedSecond))
    return { start: false, reason: 'order_predates_connection' };
  // A draft, `pending`, a terminal status and a custom status alike: the
  // value a draft carries is not documented (finding 4.7).
  if (!WOOCOMMERCE_PLACED_STATUSES.has(text(order.status)))
    return { start: false, reason: 'order_not_placed' };
  if (!text(order.payment_method))
    return { start: false, reason: 'missing_payment_signal' };
  if (!isWooCommerceCashOnDelivery(order.payment_method))
    return { start: false, reason: 'non_cod_payment_method' };
  return { start: true };
}

/** The store's text goes into a key only when it is short and opaque. */
function keyPart(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= KEY_PART_MAX_LENGTH &&
    KEY_PART_PATTERN.test(value)
    ? value
    : INVALID_KEY_PART;
}

export function buildWooCommerceOrderCreateKey(
  integrationId: string,
  orderId: string,
): string {
  return `order.create:${integrationId}:${orderId}`;
}

function buildStateKey(
  prefix: 'order.update' | 'order.skip',
  integrationId: string,
  orderId: string,
  order: WooCommerceOrderFacts,
): string {
  return `${prefix}:${integrationId}:${orderId}:${keyPart(order.status)}:${keyPart(order.date_modified_gmt)}`;
}

/**
 * Picks the route of an authenticated order delivery.
 *
 * `X-WC-Webhook-Delivery-ID` is never a key (finding 3.19). A skipped
 * delivery never uses the create key: a checkout draft stored under it would
 * turn the later placed delivery into a duplicate, and the order would never
 * be verified.
 */
export function routeWooCommerceDelivery(input: {
  integrationId: string;
  orderId: string;
  order: WooCommerceOrderFacts;
  connectedAt: string | Date;
  /** Akeed already holds a create event for this order under this source. */
  hasCreateEvent: boolean;
}): WooCommerceDeliveryRoute {
  const { integrationId, orderId, order } = input;
  if (input.hasCreateEvent)
    return {
      route: 'update',
      jobType: WebhookJobType.ORDER_UPDATE,
      idempotencyKey: buildStateKey(
        'order.update',
        integrationId,
        orderId,
        order,
      ),
    };

  const decision = evaluateWooCommerceStart(order, input.connectedAt);
  if (decision.start)
    return {
      route: 'create',
      jobType: WebhookJobType.ORDER_CREATE,
      idempotencyKey: buildWooCommerceOrderCreateKey(integrationId, orderId),
    };
  return {
    route: 'skipped',
    jobType: WebhookJobType.ORDER_CREATE,
    idempotencyKey: buildStateKey('order.skip', integrationId, orderId, order),
    reason: decision.reason,
  };
}
