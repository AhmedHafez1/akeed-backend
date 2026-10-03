export const EASYORDERS_CONFIG = 'easyOrders';

/**
 * EasyOrders connection (US-06-02).
 *
 * The switch hides every connect route. The allow-list is the pilot gate: an
 * organization may start an install only while it is listed, so an empty list
 * with the switch on still connects nobody.
 */
export interface EasyOrdersConfig {
  enabled: boolean;
  /**
   * Order-webhook ingestion (US-06-03), switched separately from connect so
   * a store can be connected and checked before its orders are accepted.
   */
  ingestionEnabled: boolean;
  pilotOrgIds: readonly string[];
  /** Public base of this API: the install callback and webhook URLs. */
  publicApiBaseUrl: string;
  /** Public base of the web app: the post-install redirect and app icon. */
  appBaseUrl: string;
}

/** The only origin the install callback's CORS preflight is answered for. */
export const EASYORDERS_DASHBOARD_ORIGIN = 'https://app.easy-orders.net';

/** Path prefix of the public install callback, without the token segment. */
export const EASYORDERS_INSTALL_CALLBACK_PATH =
  '/api/easyorders/install/callback';

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
    errors.push(`${key} must be an absolute URL when EasyOrders is enabled.`);
    return '';
  }
  const allowed = requireHttps ? ['https:'] : ['https:', 'http:'];
  if (!allowed.includes(url.protocol) || url.search || url.hash) {
    // The API key travels through the seller's browser to this URL.
    errors.push(
      `${key} must be an ${requireHttps ? 'https' : 'http(s)'} URL without a query or fragment.`,
    );
    return '';
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function parseEasyOrdersConfig(
  config: Record<string, unknown>,
): EasyOrdersConfig {
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const errors: string[] = [];
  const flag = read('EASYORDERS_CONNECT_ENABLED');
  if (flag && flag !== 'true' && flag !== 'false')
    errors.push('EASYORDERS_CONNECT_ENABLED must be true or false.');
  const enabled = flag === 'true';
  const ingestionFlag = read('EASYORDERS_INGESTION_ENABLED');
  if (ingestionFlag && ingestionFlag !== 'true' && ingestionFlag !== 'false')
    errors.push('EASYORDERS_INGESTION_ENABLED must be true or false.');
  const ingestionEnabled = ingestionFlag === 'true';

  const pilotOrgIds = [
    ...new Set(
      read('EASYORDERS_PILOT_ORG_IDS')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  // A typo would silently shut a pilot merchant out, so it fails at boot.
  if (pilotOrgIds.some((id) => !UUID_PATTERN.test(id)))
    errors.push(
      'EASYORDERS_PILOT_ORG_IDS must be a comma-separated list of organization UUIDs.',
    );

  const nodeEnv = read('NODE_ENV') || 'development';
  const requireHttps = nodeEnv !== 'development' && nodeEnv !== 'test';
  let publicApiBaseUrl = '';
  let appBaseUrl = '';
  if (enabled) {
    publicApiBaseUrl = parseBaseUrl(
      'EASYORDERS_PUBLIC_API_BASE_URL',
      read('EASYORDERS_PUBLIC_API_BASE_URL'),
      requireHttps,
      errors,
    );
    appBaseUrl = parseBaseUrl(
      'EASYORDERS_APP_BASE_URL',
      read('EASYORDERS_APP_BASE_URL'),
      requireHttps,
      errors,
    );
    // A switched-on connect that cannot encrypt the key would fail on the
    // merchant's install, after EasyOrders has already issued the key.
    if (!read('SHOPIFY_TOKEN_ENCRYPTION_KEY'))
      errors.push(
        'SHOPIFY_TOKEN_ENCRYPTION_KEY is required when EasyOrders is enabled.',
      );
  }
  // Every webhook is checked against a decrypted secret.
  if (ingestionEnabled && !enabled && !read('SHOPIFY_TOKEN_ENCRYPTION_KEY'))
    errors.push(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY is required when EasyOrders ingestion is enabled.',
    );

  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return {
    enabled,
    ingestionEnabled,
    pilotOrgIds,
    publicApiBaseUrl,
    appBaseUrl,
  };
}

/**
 * Reads the object `validateEnv` already parsed at startup, so runtime code
 * never re-derives it from raw environment strings.
 */
export function readEasyOrdersConfig(config: {
  get<T>(key: string): T | undefined;
}): EasyOrdersConfig {
  const easyOrders = config.get<EasyOrdersConfig>(EASYORDERS_CONFIG);
  if (!easyOrders)
    throw new Error('EasyOrders configuration was not validated');
  return easyOrders;
}

export function isEasyOrdersPilotOrganization(
  config: EasyOrdersConfig,
  orgId: string,
): boolean {
  return config.enabled && config.pilotOrgIds.includes(orgId.toLowerCase());
}

/**
 * Whether signup may create an organization that connects its source
 * afterwards. True while at least one connectable source is switched on.
 */
export function isSourceConnectEnabled(config: {
  get<T>(key: string): T | undefined;
}): boolean {
  return config.get<EasyOrdersConfig>(EASYORDERS_CONFIG)?.enabled === true;
}
