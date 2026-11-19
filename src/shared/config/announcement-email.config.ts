export const ANNOUNCEMENT_EMAIL_CONFIG = 'announcementEmail';
export interface AnnouncementEmailConfig {
  enabled: boolean;
  batchSize: number;
  intervalMs: number;
  publicApiUrl: string | null;
  unsubscribeSecret: string | null;
}
export function parseAnnouncementEmailConfig(
  config: Record<string, unknown>,
): AnnouncementEmailConfig {
  const text = (key: string) =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const fail = (message: string): never => {
    throw new Error(`Invalid environment configuration: ${message}`);
  };
  const flag = text('ANNOUNCEMENT_EMAIL_ENABLED');
  if (flag && flag !== 'true' && flag !== 'false')
    fail('ANNOUNCEMENT_EMAIL_ENABLED must be true or false');
  const enabled = flag === 'true';
  const batchSize = Number(text('ANNOUNCEMENT_EMAIL_BATCH_SIZE') || 50);
  const intervalMs = Number(text('ANNOUNCEMENT_EMAIL_INTERVAL_MS') || 300000);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    fail('ANNOUNCEMENT_EMAIL_BATCH_SIZE must be 1–100');
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 60000 ||
    intervalMs > 86400000
  )
    fail('ANNOUNCEMENT_EMAIL_INTERVAL_MS must be 60000–86400000');
  const publicApiUrl = text('ANNOUNCEMENT_EMAIL_PUBLIC_API_URL') || null;
  const unsubscribeSecret =
    text('ANNOUNCEMENT_EMAIL_UNSUBSCRIBE_SECRET') || null;
  if (enabled) {
    let validDashboard = false;
    try {
      const dashboard = new URL(text('FRONTEND_DASHBOARD_URL'));
      validDashboard =
        dashboard.protocol === 'https:' &&
        !dashboard.username &&
        !dashboard.password;
    } catch {
      /* Report the setting name only. */
    }
    if (!validDashboard)
      fail('FRONTEND_DASHBOARD_URL must be an HTTPS URL for announcements');
  }
  if (publicApiUrl) {
    let valid = false;
    try {
      const url = new URL(publicApiUrl);
      valid =
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/';
    } catch {
      /* Report only the key, never its value. */
    }
    if (!valid)
      fail('ANNOUNCEMENT_EMAIL_PUBLIC_API_URL must be an HTTPS origin');
  }
  if (
    enabled &&
    (text('EMAIL_ALERTS_ENABLED') !== 'true' ||
      !text('RESEND_API_KEY') ||
      !text('EMAIL_FROM') ||
      !text('FRONTEND_DASHBOARD_URL') ||
      !publicApiUrl ||
      !unsubscribeSecret ||
      unsubscribeSecret.length < 32)
  )
    fail(
      'Announcement sending needs email transport, dashboard/public API URLs and a signing secret of at least 32 characters',
    );
  return { enabled, batchSize, intervalMs, publicApiUrl, unsubscribeSecret };
}
export function readAnnouncementEmailConfig(config: {
  get<T>(key: string): T | undefined;
}): AnnouncementEmailConfig {
  return (
    config.get<AnnouncementEmailConfig>(ANNOUNCEMENT_EMAIL_CONFIG) ??
    parseAnnouncementEmailConfig({})
  );
}
