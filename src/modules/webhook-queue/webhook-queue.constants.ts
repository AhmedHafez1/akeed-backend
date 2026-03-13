/**
 * Central constants for the webhook job queue system.
 *
 * These values are shared across producers (controllers) and consumers (processors).
 * Changing a queue name here automatically propagates everywhere.
 */

export const WEBHOOK_QUEUE_NAME = 'webhook-processing';

/** Job types routed through the webhook queue. */
export enum WebhookJobType {
  ORDER_CREATE = 'order.create',
  ORDER_UPDATE = 'order.update',
  APP_UNINSTALLED = 'app.uninstalled',
  SUBSCRIPTION_UPDATE = 'subscription.update',
}

/** Supported e-commerce platforms. Must match `integrations.platform_type`. */
export type PlatformType = 'shopify' | 'salla' | 'woocommerce' | 'zid';

export const ALL_PLATFORMS: readonly PlatformType[] = [
  'shopify',
  'salla',
  'woocommerce',
  'zid',
] as const;
