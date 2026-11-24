export const SHIPPING_NOTIFICATIONS_CONFIG = 'shippingNotifications';

/** Whether shipping notifications run at all. */
export interface ShippingNotificationsConfig {
  /**
   * Off: the settings are hidden and refused, and store order-update events
   * are acknowledged without being stored.
   */
  enabled: boolean;
}

export const SHIPPING_NOTIFICATIONS_OFF: ShippingNotificationsConfig = {
  enabled: false,
};

export function parseShippingNotificationsConfig(
  config: Record<string, unknown>,
): ShippingNotificationsConfig {
  const raw = config.SHIPPING_NOTIFICATIONS_ENABLED;
  const flag = typeof raw === 'string' ? raw.trim() : '';
  if (flag && flag !== 'true' && flag !== 'false') {
    throw new Error(
      'Invalid environment configuration:\n - SHIPPING_NOTIFICATIONS_ENABLED must be true or false.',
    );
  }
  return { enabled: flag === 'true' };
}

export function readShippingNotificationsConfig(config: {
  get<T>(key: string): T | undefined;
}): ShippingNotificationsConfig {
  return (
    config.get<ShippingNotificationsConfig>(SHIPPING_NOTIFICATIONS_CONFIG) ??
    SHIPPING_NOTIFICATIONS_OFF
  );
}
