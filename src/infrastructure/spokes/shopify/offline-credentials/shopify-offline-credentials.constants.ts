/**
 * BullMQ queue that moves installed stores from non-expiring Shopify offline
 * tokens to expiring ones in small batches, and renews refresh tokens before
 * they lapse on stores that make no Admin API calls.
 */
export const SHOPIFY_OFFLINE_CREDENTIALS_QUEUE = 'shopify-offline-credentials';
export const SHOPIFY_OFFLINE_CREDENTIALS_JOB =
  'shopify-offline-credentials.run';
export const SHOPIFY_OFFLINE_CREDENTIALS_SCHEDULER =
  'shopify-offline-credentials-every-15m';
export const SHOPIFY_OFFLINE_CREDENTIALS_EVERY_MS = 15 * 60_000;

/** Off by default; `true` starts moving stores in batches. */
export const SHOPIFY_TOKEN_MIGRATION_ENABLED_KEY =
  'SHOPIFY_TOKEN_MIGRATION_ENABLED';
/** Stores moved per run (default 10, 1–100). */
export const SHOPIFY_TOKEN_MIGRATION_BATCH_SIZE_KEY =
  'SHOPIFY_TOKEN_MIGRATION_BATCH_SIZE';
/** Optional comma-separated shop domains; when set, only these move. */
export const SHOPIFY_TOKEN_MIGRATION_SHOPS_KEY =
  'SHOPIFY_TOKEN_MIGRATION_SHOPS';
/** On by default; `false` stops the refresh-token keep-alive. */
export const SHOPIFY_TOKEN_REFRESH_JOB_ENABLED_KEY =
  'SHOPIFY_TOKEN_REFRESH_JOB_ENABLED';

export const DEFAULT_MIGRATION_BATCH_SIZE = 10;
export const MAX_MIGRATION_BATCH_SIZE = 100;
export const KEEP_ALIVE_BATCH_SIZE = 100;

export function isTokenMigrationEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function isTokenRefreshJobEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

export function parseMigrationBatchSize(value: string | undefined): number {
  const parsed = Number(value?.trim());
  if (!value?.trim() || !Number.isInteger(parsed) || parsed < 1)
    return DEFAULT_MIGRATION_BATCH_SIZE;
  return Math.min(parsed, MAX_MIGRATION_BATCH_SIZE);
}

/** Empty means every store. */
export function parseMigrationShops(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((shop) => shop.trim().toLowerCase())
    .filter((shop) => shop.length > 0);
}

/** Whether a store may move now: the switch is on and the canary list allows it. */
export function isShopInMigrationScope(
  shop: string,
  enabled: string | undefined,
  shops: string | undefined,
): boolean {
  if (!isTokenMigrationEnabled(enabled)) return false;
  const allowed = parseMigrationShops(shops);
  return allowed.length === 0 || allowed.includes(shop.toLowerCase());
}

export interface ShopifyOfflineCredentialsSummary {
  migrated: number;
  migrationFailed: number;
  reauthRequired: number;
  refreshed: number;
  refreshFailed: number;
  skipped: number;
}
