/** The delivery stage a shipping notification announces. v1 has one. */
export const SHIPPING_STAGES = ['shipped'] as const;
export type ShippingStage = (typeof SHIPPING_STAGES)[number];

/** What in the store made the order count as shipped. */
export const SHIPPING_TRIGGERS = ['fulfillment', 'tag'] as const;
export type ShippingTrigger = (typeof SHIPPING_TRIGGERS)[number];

export const SHIPPING_NOTIFICATION_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type ShippingNotificationStatus =
  (typeof SHIPPING_NOTIFICATION_STATUSES)[number];

/** Why a shipping notification is `failed`. Shown to the merchant by code. */
export const SHIPPING_FAILURE_REASONS = [
  'no_phone',
  'not_on_whatsapp',
  'allowance_low',
  'no_allowance',
  'order_too_old',
  'order_cancelled',
  'send_failed',
  'template_unavailable',
] as const;
export type ShippingFailureReason = (typeof SHIPPING_FAILURE_REASONS)[number];

export interface ShippingTracking {
  number?: string;
  url?: string;
}
