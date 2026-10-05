export const WOOCOMMERCE_CONFIG = 'wooCommerce';

/**
 * WooCommerce connection (US-07-02), order ingestion (US-07-03) and outcome
 * writes (US-07-04).
 *
 * The switch hides the start-install and callback routes. The optional
 * allow-list restricts installs when populated; an empty list allows any
 * organization.
 */
export interface WooCommerceConfig {
  enabled: boolean;
  /** While false the delivery URL answers 404 to every order delivery. */
  ingestionEnabled: boolean;
  /**
   * Remote outcome writes (US-07-04). Off means the outcome adapter has no
   * capability: nothing is sent to any store and every outcome stays local.
   */
  outcomeSyncEnabled: boolean;
  pilotOrgIds: readonly string[];
  /** Public base of this API: the install callback and webhook delivery URLs. */
  publicApiBaseUrl: string;
  /** Public base of the web app: where the store sends the merchant back. */
  appBaseUrl: string;
}

/** Path prefix of the public install callback, without the token segment. */
export const WOOCOMMERCE_INSTALL_CALLBACK_PATH =
  '/api/woocommerce/install/callback';

/** Path prefix of the webhook delivery URL, without the token segment. */
export const WOOCOMMERCE_WEBHOOK_PATH = '/api/woocommerce/webhooks';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseBaseUrl(
  key: string,
  raw: string,
  requireHttps: boolean,
  errors: string[],
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    errors.push(`${key} must be an absolute URL when WooCommerce is enabled.`);
    return '';
  }
  const allowed = requireHttps ? ['https:'] : ['https:', 'http:'];
  if (!allowed.includes(url.protocol) || url.search || url.hash) {
    // The store posts the new API keys to this URL.
    errors.push(
      `${key} must be an ${requireHttps ? 'https' : 'http(s)'} URL without a query or fragment.`,
    );
    return '';
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function parseWooCommerceConfig(
  config: Record<string, unknown>,
): WooCommerceConfig {
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const errors: string[] = [];
  const flag = read('WOOCOMMERCE_CONNECT_ENABLED');
  if (flag && flag !== 'true' && flag !== 'false')
    errors.push('WOOCOMMERCE_CONNECT_ENABLED must be true or false.');
  const enabled = flag === 'true';
  const ingestionFlag = read('WOOCOMMERCE_INGESTION_ENABLED');
  if (ingestionFlag && ingestionFlag !== 'true' && ingestionFlag !== 'false')
    errors.push('WOOCOMMERCE_INGESTION_ENABLED must be true or false.');
  const ingestionEnabled = ingestionFlag === 'true';
  const outcomeSyncFlag = read('WOOCOMMERCE_OUTCOME_SYNC_ENABLED');
  if (
    outcomeSyncFlag &&
    outcomeSyncFlag !== 'true' &&
    outcomeSyncFlag !== 'false'
  )
    errors.push('WOOCOMMERCE_OUTCOME_SYNC_ENABLED must be true or false.');
  const outcomeSyncEnabled = outcomeSyncFlag === 'true';

  const pilotOrgIds = [
    ...new Set(
      read('WOOCOMMERCE_PILOT_ORG_IDS')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  // A typo would silently shut a pilot merchant out, so it fails at boot.
  if (pilotOrgIds.some((id) => !UUID_PATTERN.test(id)))
    errors.push(
      'WOOCOMMERCE_PILOT_ORG_IDS must be a comma-separated list of organization UUIDs.',
    );

  const nodeEnv = read('NODE_ENV') || 'development';
  const requireHttps = nodeEnv !== 'development' && nodeEnv !== 'test';
  let publicApiBaseUrl = '';
  let appBaseUrl = '';
  if (enabled) {
    publicApiBaseUrl = parseBaseUrl(
      'WOOCOMMERCE_PUBLIC_API_BASE_URL',
      read('WOOCOMMERCE_PUBLIC_API_BASE_URL'),
      requireHttps,
      errors,
    );
    appBaseUrl = parseBaseUrl(
      'WOOCOMMERCE_APP_BASE_URL',
      read('WOOCOMMERCE_APP_BASE_URL'),
      requireHttps,
      errors,
    );
    // A switched-on connect that cannot encrypt the keys would fail on the
    // merchant's install, after the store has already issued them.
    if (!read('SHOPIFY_TOKEN_ENCRYPTION_KEY'))
      errors.push(
        'SHOPIFY_TOKEN_ENCRYPTION_KEY is required when WooCommerce is enabled.',
      );
  }
  // Every delivery is checked against a decrypted webhook secret.
  if (ingestionEnabled && !enabled && !read('SHOPIFY_TOKEN_ENCRYPTION_KEY'))
    errors.push(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY is required when WooCommerce ingestion is enabled.',
    );
  // Every outcome write decrypts the integration's own consumer key.
  if (outcomeSyncEnabled && !enabled && !read('SHOPIFY_TOKEN_ENCRYPTION_KEY'))
    errors.push(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY is required when WooCommerce outcome sync is enabled.',
    );

  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return {
    enabled,
    ingestionEnabled,
    outcomeSyncEnabled,
    pilotOrgIds,
    publicApiBaseUrl,
    appBaseUrl,
  };
}

/**
 * Reads the object `validateEnv` already parsed at startup, so runtime code
 * never re-derives it from raw environment strings.
 */
export function readWooCommerceConfig(config: {
  get<T>(key: string): T | undefined;
}): WooCommerceConfig {
  const wooCommerce = config.get<WooCommerceConfig>(WOOCOMMERCE_CONFIG);
  if (!wooCommerce)
    throw new Error('WooCommerce configuration was not validated');
  return wooCommerce;
}

export function isWooCommercePilotOrganization(
  config: WooCommerceConfig,
  orgId: string,
): boolean {
  return (
    config.enabled &&
    (config.pilotOrgIds.length === 0 ||
      config.pilotOrgIds.includes(orgId.toLowerCase()))
  );
}
