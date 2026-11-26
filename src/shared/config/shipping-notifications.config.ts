export const SHIPPING_NOTIFICATIONS_CONFIG = 'shippingNotifications';

/** Whether shipping notifications run at all, and where their links point. */
export interface ShippingNotificationsConfig {
  /**
   * Off: the settings are hidden and refused, and store order-update events
   * are acknowledged without being stored.
   */
  enabled: boolean;
  /**
   * The site origin the Shipped message's Track order button links to, for
   * example `https://getakeed.com`. It is written into each Shipped template
   * when it is submitted, so an approved template keeps the origin it was
   * submitted with. Null leaves Shipped drafts unsubmittable.
   */
  trackingLinkBaseUrl?: string | null;
}

export const SHIPPING_NOTIFICATIONS_OFF: ShippingNotificationsConfig = {
  enabled: false,
  trackingLinkBaseUrl: null,
};

/** An HTTPS origin with no path, query, fragment or trailing slash. */
function parseTrackingLinkBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
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

export function parseShippingNotificationsConfig(
  config: Record<string, unknown>,
): ShippingNotificationsConfig {
  const read = (key: string): string => {
    const value = config[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const errors: string[] = [];
  const flag = read('SHIPPING_NOTIFICATIONS_ENABLED');
  if (flag && flag !== 'true' && flag !== 'false')
    errors.push('SHIPPING_NOTIFICATIONS_ENABLED must be true or false.');
  const enabled = flag === 'true';
  const rawBase = read('SHIPPING_TRACKING_LINK_BASE_URL');
  const trackingLinkBaseUrl = rawBase
    ? parseTrackingLinkBaseUrl(rawBase)
    : null;
  if (rawBase && !trackingLinkBaseUrl)
    errors.push(
      'SHIPPING_TRACKING_LINK_BASE_URL must be an HTTPS origin with no trailing slash, path, query or fragment.',
    );
  if (enabled && !rawBase)
    errors.push(
      'SHIPPING_TRACKING_LINK_BASE_URL is required when SHIPPING_NOTIFICATIONS_ENABLED=true.',
    );
  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n${errors.map((line) => ` - ${line}`).join('\n')}`,
    );
  return { enabled, trackingLinkBaseUrl };
}

export function readShippingNotificationsConfig(config: {
  get<T>(key: string): T | undefined;
}): ShippingNotificationsConfig {
  return (
    config.get<ShippingNotificationsConfig>(SHIPPING_NOTIFICATIONS_CONFIG) ??
    SHIPPING_NOTIFICATIONS_OFF
  );
}
