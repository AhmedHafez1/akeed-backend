export const ORDER_API_CONFIG = 'orderApi';

/** Every rate limit below counts requests in this window. */
export const ORDER_API_RATE_WINDOW_MS = 60_000;

/**
 * Abuse controls of the server order API (US-05-04).
 *
 * The limits count HTTP requests only. Verification usage stays with the
 * readiness gates, so a request that passes here can still be refused for
 * credit or plan reasons.
 */
export interface OrderApiConfig {
  /** Requests a minute for one integration, whichever of its keys is used. */
  perIntegrationPerMinute: number;
  /** Authenticated requests a minute across all integrations. */
  globalPerMinute: number;
  /**
   * Requests a minute from one client address, counted before the key is
   * checked, so traffic without a valid key is bounded too.
   */
  preAuthPerIpPerMinute: number;
  /** Largest request body accepted under `/api/v1`. */
  maxBodyBytes: number;
}

interface IntegerSetting {
  key: string;
  field: keyof OrderApiConfig;
  fallback: number;
  min: number;
  max: number;
}

const INTEGER_SETTINGS: readonly IntegerSetting[] = [
  {
    key: 'ORDER_API_RATE_LIMIT_PER_INTEGRATION',
    field: 'perIntegrationPerMinute',
    // Pilot default: one order a second, sustained.
    fallback: 60,
    min: 1,
    max: 6_000,
  },
  {
    key: 'ORDER_API_RATE_LIMIT_GLOBAL',
    field: 'globalPerMinute',
    fallback: 300,
    min: 1,
    max: 60_000,
  },
  {
    key: 'ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP',
    field: 'preAuthPerIpPerMinute',
    // Above the global limit on purpose: behind a proxy every client shares
    // one address, and this ceiling must not cut authenticated traffic short.
    fallback: 600,
    min: 1,
    max: 120_000,
  },
  {
    key: 'ORDER_API_MAX_BODY_BYTES',
    field: 'maxBodyBytes',
    fallback: 32 * 1024,
    min: 1_024,
    // The app-wide JSON parser stops at 100 KB; this route never allows more.
    max: 100 * 1024,
  },
];

export function parseOrderApiConfig(
  config: Record<string, unknown>,
): OrderApiConfig {
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const errors: string[] = [];
  const parsed: OrderApiConfig = {
    perIntegrationPerMinute: 0,
    globalPerMinute: 0,
    preAuthPerIpPerMinute: 0,
    maxBodyBytes: 0,
  };
  for (const setting of INTEGER_SETTINGS) {
    const raw = read(setting.key);
    const value = raw ? Number(raw) : setting.fallback;
    if (
      !Number.isInteger(value) ||
      value < setting.min ||
      value > setting.max
    ) {
      errors.push(
        `${setting.key} must be an integer from ${setting.min} to ${setting.max}.`,
      );
      continue;
    }
    parsed[setting.field] = value;
  }
  // A wider bucket below a narrower one would make the narrower limit
  // unreachable, which reads as a working limit until a pilot client hits it.
  if (errors.length === 0) {
    if (parsed.perIntegrationPerMinute > parsed.globalPerMinute)
      errors.push(
        'ORDER_API_RATE_LIMIT_PER_INTEGRATION must not exceed ORDER_API_RATE_LIMIT_GLOBAL.',
      );
    if (parsed.globalPerMinute > parsed.preAuthPerIpPerMinute)
      errors.push(
        'ORDER_API_RATE_LIMIT_GLOBAL must not exceed ORDER_API_RATE_LIMIT_PRE_AUTH_PER_IP.',
      );
  }
  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return parsed;
}

/**
 * Reads the object `validateEnv` already parsed at startup, so runtime code
 * never re-derives limits from raw environment strings.
 */
export function readOrderApiConfig(config: {
  get<T>(key: string): T | undefined;
}): OrderApiConfig {
  const orderApi = config.get<OrderApiConfig>(ORDER_API_CONFIG);
  if (!orderApi) throw new Error('Order API configuration was not validated');
  return orderApi;
}
