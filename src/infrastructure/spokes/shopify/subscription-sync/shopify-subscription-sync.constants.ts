/**
 * BullMQ queue for the daily Shopify subscription reconciliation. Shopify's
 * `app_subscriptions/update` webhook is the fast path; this asks Shopify for
 * each paid store's subscription status so a webhook that never arrived (or
 * was rejected) cannot leave a cancelled store sending messages.
 */
export const SHOPIFY_SUBSCRIPTION_SYNC_QUEUE = 'shopify-subscription-sync';
export const SHOPIFY_SUBSCRIPTION_SYNC_JOB = 'shopify-subscription.sync';
export const SHOPIFY_SUBSCRIPTION_SYNC_SCHEDULER =
  'shopify-subscription-sync-daily';
export const SHOPIFY_SUBSCRIPTION_SYNC_EVERY_MS = 24 * 60 * 60_000;

/** Defaults to on; `SHOPIFY_SUBSCRIPTION_SYNC_ENABLED=false` switches it off. */
export const SHOPIFY_SUBSCRIPTION_SYNC_ENABLED_KEY =
  'SHOPIFY_SUBSCRIPTION_SYNC_ENABLED';

export function isShopifySubscriptionSyncEnabled(
  value: string | undefined,
): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

export interface ShopifySubscriptionSyncSummary {
  checked: number;
  unchanged: number;
  corrected: number;
  ignored: number;
  /** Not blocked: Shopify bills the store through a different subscription. */
  held: number;
  failed: number;
}
