import {
  SHIPPING_CUSTOMER_REPLIES,
  type ShippingCustomerReply,
} from './shipping-notification.types';

/** The version prefix of a Shipped message's quick-reply payload. */
export const SHIPPING_PAYLOAD_PREFIX = 'sh1|';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Shipped message's buttons, in template order. */
export const SHIPPING_BUTTON_ORDER: readonly ShippingCustomerReply[] = [
  'home',
  'reschedule',
  'address',
];

/** `sh1|<home|reschedule|address>|<verificationId>`. */
export function shippingButtonPayload(
  reply: ShippingCustomerReply,
  verificationId: string,
): string {
  return `${SHIPPING_PAYLOAD_PREFIX}${reply}|${verificationId}`;
}

/** The three payloads of one Shipped message, in button order. */
export function shippingButtonPayloads(verificationId: string): string[] {
  return SHIPPING_BUTTON_ORDER.map((reply) =>
    shippingButtonPayload(reply, verificationId),
  );
}

export function isShippingPayload(payload: string | null | undefined): boolean {
  return (
    typeof payload === 'string' && payload.startsWith(SHIPPING_PAYLOAD_PREFIX)
  );
}

/**
 * Reads a Shipped message's quick reply. Anything else, including a payload
 * with an extra part, an unknown reply or a malformed id, is not one.
 */
export function resolveShippingPayload(
  payload: string | null | undefined,
): { reply: ShippingCustomerReply; verificationId: string } | null {
  if (!isShippingPayload(payload)) return null;
  const parts = (payload as string).split('|');
  if (parts.length !== 3) return null;
  const [, reply, verificationId] = parts;
  if (!(SHIPPING_CUSTOMER_REPLIES as readonly string[]).includes(reply))
    return null;
  if (!UUID.test(verificationId)) return null;
  return {
    reply: reply as ShippingCustomerReply,
    verificationId: verificationId.toLowerCase(),
  };
}
