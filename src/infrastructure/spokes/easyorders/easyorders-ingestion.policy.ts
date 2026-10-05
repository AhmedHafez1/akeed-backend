/**
 * The ingestion rule of an EasyOrders webhook (US-06-03, contract record
 * sections 3 and 6): what a payload must look like to be taken, and the
 * idempotency key it is stored under. Pure, so the webhook service only
 * authenticates and persists.
 */

/** The one event type the status webhook is documented to send. */
export const EASYORDERS_STATUS_EVENT_TYPE = 'order-status-update';

const ID_MAX_LENGTH = 128;
const STATUS_MAX_LENGTH = 64;
/** Printable ASCII without spaces: an id or a status, never free text. */
const OPAQUE_VALUE_PATTERN = /^[\x21-\x7E]+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOpaque(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    OPAQUE_VALUE_PATTERN.test(value)
  );
}

/** An order id as it may enter an idempotency key. */
export function isEasyOrdersOpaqueId(value: unknown): value is string {
  return isOpaque(value, ID_MAX_LENGTH);
}

/** A status as it may enter an idempotency key. */
export function isEasyOrdersOpaqueStatus(value: unknown): value is string {
  return isOpaque(value, STATUS_MAX_LENGTH);
}

/** Source-scoped keys for a provider that sends no delivery id (section 3). */
export function buildOrderCreatedKey(
  integrationId: string,
  orderId: string,
): string {
  return `order.create:${integrationId}:${orderId}`;
}

export function buildOrderStatusKey(
  integrationId: string,
  event: { orderId: string; oldStatus: string; newStatus: string },
): string {
  return `order.status:${integrationId}:${event.orderId}:${event.oldStatus}:${event.newStatus}`;
}
