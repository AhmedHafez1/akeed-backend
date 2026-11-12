export { SHOPIFY_UNINSTALL_DATA_RETENTION_MS } from '../../../../shared/commerce/shopify-data-retention';

export const SHOPIFY_UNINSTALL_RETENTION_QUEUE = 'shopify-uninstall-retention';
export const SHOPIFY_UNINSTALL_RETENTION_JOB = 'shopify-uninstall-retention';
export const SHOPIFY_UNINSTALL_RETENTION_SCHEDULER =
  'shopify-uninstall-retention-every-15m';
export const SHOPIFY_UNINSTALL_RETENTION_EVERY_MS = 15 * 60 * 1000;
/** Stores deleted per run; the next run (15 min later) picks up the rest. */
export const SHOPIFY_UNINSTALL_RETENTION_BATCH = 100;
