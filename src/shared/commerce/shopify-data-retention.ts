/**
 * Shopify's 48-hour rule: a store's data is kept for 48 hours after
 * `app/uninstalled` so a reinstall in that window gets its history back, and
 * deleted once it closes (or on `shop/redact`, which Shopify sends then).
 *
 * This is a compliance window, not tuning: it is deliberately a constant and
 * not an environment setting, so it cannot drift between environments.
 */
export const SHOPIFY_UNINSTALL_DATA_RETENTION_MS = 48 * 60 * 60 * 1000;
