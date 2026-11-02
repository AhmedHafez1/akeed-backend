export const WHATSAPP_OWN_NUMBER_CONFIG = 'whatsappOwnNumber';

/**
 * A merchant's own WhatsApp number.
 *
 * Connecting and sending are switched separately: connect offers signup, and
 * sending is the kill switch that sends every message from Akeed's number
 * while connections stay as they are. Both are off when absent. The optional
 * allow-list restricts both when populated; an empty list allows every
 * organization while a switch is on. Meta webhook processing ignores these
 * switches, so connection state stays correct while they are off.
 */
export interface WhatsappOwnNumberConfig {
  connectEnabled: boolean;
  sendingEnabled: boolean;
  pilotOrgIds: readonly string[];
  /** Embedded Signup configuration; set whenever connect is on. */
  embeddedSignupConfigId: string | null;
  /** `META_APP_ID`, which launches Embedded Signup; set whenever connect is on. */
  metaAppId: string | null;
  /**
   * Origin of the web app that hosts the connect page, for example
   * `https://getakeed.com`; set whenever connect is on. Connect links are
   * built from it, never from a client-supplied address.
   */
  connectPageBaseUrl: string | null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** An origin with no path, query or fragment; HTTPS except on this machine. */
function parseConnectPageBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (
    !secure ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '') ||
    value.endsWith('/')
  )
    return null;
  return url.origin;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const META_ID_PATTERN = /^\d{1,32}$/;

export function parseWhatsappOwnNumberConfig(
  config: Record<string, unknown>,
): WhatsappOwnNumberConfig {
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const errors: string[] = [];
  const flag = (key: string): boolean => {
    const value = read(key);
    if (value && value !== 'true' && value !== 'false')
      errors.push(`${key} must be true or false.`);
    return value === 'true';
  };
  const connectEnabled = flag('WHATSAPP_OWN_NUMBER_CONNECT_ENABLED');
  const sendingEnabled = flag('WHATSAPP_OWN_NUMBER_SENDING_ENABLED');

  const pilotOrgIds = [
    ...new Set(
      read('WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  // A typo would silently shut a pilot merchant out, so it fails at boot.
  if (pilotOrgIds.some((id) => !UUID_PATTERN.test(id)))
    errors.push(
      'WHATSAPP_OWN_NUMBER_PILOT_ORG_IDS must be a comma-separated list of organization UUIDs.',
    );

  const embeddedSignupConfigId = read('META_EMBEDDED_SIGNUP_CONFIG_ID');
  if (embeddedSignupConfigId && !META_ID_PATTERN.test(embeddedSignupConfigId))
    errors.push(
      'META_EMBEDDED_SIGNUP_CONFIG_ID must be the numeric Embedded Signup configuration ID.',
    );
  const metaAppId = read('META_APP_ID');
  const rawConnectPageBaseUrl = read('WHATSAPP_CONNECT_PAGE_BASE_URL');
  const connectPageBaseUrl = rawConnectPageBaseUrl
    ? parseConnectPageBaseUrl(rawConnectPageBaseUrl)
    : null;
  if (rawConnectPageBaseUrl && !connectPageBaseUrl)
    errors.push(
      'WHATSAPP_CONNECT_PAGE_BASE_URL must be an HTTPS origin with no trailing slash, path, query or fragment.',
    );
  if (connectEnabled) {
    if (!rawConnectPageBaseUrl)
      errors.push(
        'WHATSAPP_CONNECT_PAGE_BASE_URL is required when WHATSAPP_OWN_NUMBER_CONNECT_ENABLED=true.',
      );
    if (!embeddedSignupConfigId)
      errors.push(
        'META_EMBEDDED_SIGNUP_CONFIG_ID is required when WHATSAPP_OWN_NUMBER_CONNECT_ENABLED=true.',
      );
    // Embedded Signup launches with the app ID; its format is checked with
    // the template settings.
    if (!metaAppId)
      errors.push(
        'META_APP_ID is required when WHATSAPP_OWN_NUMBER_CONNECT_ENABLED=true.',
      );
  }
  // Signup stores the business token encrypted, and every own-number send
  // decrypts it.
  if (
    (connectEnabled || sendingEnabled) &&
    !read('SHOPIFY_TOKEN_ENCRYPTION_KEY')
  )
    errors.push(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY is required when the merchant own-number switches are on.',
    );

  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return {
    connectEnabled,
    sendingEnabled,
    pilotOrgIds,
    embeddedSignupConfigId: connectEnabled ? embeddedSignupConfigId : null,
    metaAppId: connectEnabled ? metaAppId : null,
    connectPageBaseUrl: connectEnabled ? connectPageBaseUrl : null,
  };
}

/**
 * Reads the object `validateEnv` already parsed at startup, so runtime code
 * never re-derives it from raw environment strings.
 */
export function readWhatsappOwnNumberConfig(config: {
  get<T>(key: string): T | undefined;
}): WhatsappOwnNumberConfig {
  const parsed = config.get<WhatsappOwnNumberConfig>(
    WHATSAPP_OWN_NUMBER_CONFIG,
  );
  if (!parsed)
    throw new Error('WhatsApp own-number configuration was not validated');
  return parsed;
}

function isPilotOrganization(
  config: WhatsappOwnNumberConfig,
  orgId: string,
): boolean {
  return (
    config.pilotOrgIds.length === 0 ||
    config.pilotOrgIds.includes(orgId.toLowerCase())
  );
}

/** Whether the organization may connect its own number. */
export function isOwnNumberConnectAllowed(
  config: WhatsappOwnNumberConfig,
  orgId: string,
): boolean {
  return config.connectEnabled && isPilotOrganization(config, orgId);
}

/** Whether the organization's messages may go from its own number. */
export function isOwnNumberSendingAllowed(
  config: WhatsappOwnNumberConfig,
  orgId: string,
): boolean {
  return config.sendingEnabled && isPilotOrganization(config, orgId);
}
