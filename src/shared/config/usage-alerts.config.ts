import { DEFAULT_BLOCKED_ORDER_MAX_AGE_HOURS } from '../verification/capacity-block';

export const USAGE_ALERTS_CONFIG = 'usageAlerts';

/**
 * Merchant usage alerts and the recovery of orders blocked by capacity.
 *
 * - `emailEnabled`: send alert emails through Resend. Off: alerts are still
 *   recorded (and shown on the dashboard); the email is logged as skipped.
 * - `recoveryEnabled`: resume blocked orders after a recharge, an upgrade or
 *   an allowance reset. Off: they wait for a merchant retry.
 * - `blockedOrderMaxAgeHours`: older blocked orders are left to the merchant
 *   instead of being sent.
 */
export interface UsageAlertsConfig {
  emailEnabled: boolean;
  resendApiKey: string | null;
  emailFrom: string | null;
  dashboardUrl: string | null;
  recoveryEnabled: boolean;
  blockedOrderMaxAgeHours: number;
}

function fail(message: string): never {
  throw new Error(`Invalid environment configuration:\n - ${message}`);
}

function readText(config: Record<string, unknown>, key: string) {
  const value = config[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readBoolean(
  config: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = readText(config, key);
  if (value === null) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`${key} must be true or false.`);
}

export function parseUsageAlertsConfig(
  config: Record<string, unknown>,
): UsageAlertsConfig {
  const emailEnabled = readBoolean(config, 'EMAIL_ALERTS_ENABLED', false);
  const resendApiKey = readText(config, 'RESEND_API_KEY');
  const emailFrom = readText(config, 'EMAIL_FROM');
  if (emailEnabled && (!resendApiKey || !emailFrom)) {
    fail('EMAIL_ALERTS_ENABLED=true needs RESEND_API_KEY and EMAIL_FROM.');
  }
  const maxAgeRaw = readText(config, 'BLOCKED_ORDER_MAX_AGE_HOURS');
  const blockedOrderMaxAgeHours =
    maxAgeRaw === null
      ? DEFAULT_BLOCKED_ORDER_MAX_AGE_HOURS
      : Number(maxAgeRaw);
  if (
    !Number.isInteger(blockedOrderMaxAgeHours) ||
    blockedOrderMaxAgeHours < 1 ||
    blockedOrderMaxAgeHours > 720
  ) {
    fail('BLOCKED_ORDER_MAX_AGE_HOURS must be a whole number from 1 to 720.');
  }
  return {
    emailEnabled,
    resendApiKey,
    emailFrom,
    dashboardUrl: readText(config, 'FRONTEND_DASHBOARD_URL'),
    recoveryEnabled: readBoolean(
      config,
      'BLOCKED_ORDER_RECOVERY_ENABLED',
      true,
    ),
    blockedOrderMaxAgeHours,
  };
}

export function readUsageAlertsConfig(config: {
  get<T>(key: string): T | undefined;
}): UsageAlertsConfig {
  return (
    config.get<UsageAlertsConfig>(USAGE_ALERTS_CONFIG) ??
    parseUsageAlertsConfig({})
  );
}
