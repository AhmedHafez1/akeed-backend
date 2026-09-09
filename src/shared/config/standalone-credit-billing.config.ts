import { isIP } from 'node:net';
import type { PaymentMode } from '../ports/payments.port';

export const STANDALONE_CREDIT_BILLING_CONFIG = 'standaloneCreditBilling';
const MAX_DATABASE_INTEGER = 2147483647;

interface CreditPricingConfig {
  priceMinor: number;
  freeGrant: number;
  purchaseMin: number;
  purchaseMax: number;
  purchaseStep: number;
  lowBalanceThreshold: number;
}

interface PaymobConfiguration {
  mode: PaymentMode;
  baseUrl: string;
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  cardIntegrationId: string;
  walletIntegrationId: string;
  callbackUrl: string;
  returnUrl: string;
  checkoutExpirationSeconds: number;
}

export type StandaloneCreditBillingConfig = CreditPricingConfig &
  ({ enabled: false } | { enabled: true; paymob: PaymobConfiguration });

function placeholder(value: string): boolean {
  return /^(?:changeme|placeholder|replace[-_ ]?me|your[-_ ]|example|dummy|todo|<)|(?:^|[_ -])(?:changeme|placeholder|dummy|example)(?:$|[_ -])|(?:\.example\b|\.invalid\b)/i.test(
    value,
  );
}

function publicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    isIP(host.replace(/^\[|\]$/g, '')) === 0 &&
    host.includes('.') &&
    !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) &&
    !/(^|\.)example\.(com|net|org)$/.test(host) &&
    !/(^|\.)(localtest\.me|lvh\.me|nip\.io|sslip\.io)$/.test(host)
  );
}

/**
 * Reads the object `validateEnv` already parsed at startup. Runtime code must
 * never re-derive billing settings from raw environment strings.
 */
export function readStandaloneCreditBillingConfig(config: {
  get<T>(key: string): T | undefined;
}): StandaloneCreditBillingConfig {
  const billing = config.get<StandaloneCreditBillingConfig>(
    STANDALONE_CREDIT_BILLING_CONFIG,
  );
  if (!billing) {
    throw new Error('Standalone billing configuration was not validated');
  }
  return billing;
}

export function parseStandaloneCreditBillingConfig(
  config: Record<string, unknown>,
): StandaloneCreditBillingConfig {
  const errors: string[] = [];
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const integer = (key: string, fallback?: number, minimum = 1): number => {
    const value = read(key);
    if (!value && config[key] === undefined && fallback !== undefined) {
      return fallback;
    }
    const parsed = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(parsed) ||
      parsed < minimum ||
      parsed > MAX_DATABASE_INTEGER
    ) {
      errors.push(
        `${key} must be an integer between ${minimum} and ${MAX_DATABASE_INTEGER}.`,
      );
      return fallback ?? minimum;
    }
    return parsed;
  };
  const rawFlag = config.STANDALONE_CREDIT_BILLING_ENABLED;
  if (rawFlag !== undefined && rawFlag !== 'true' && rawFlag !== 'false') {
    errors.push('STANDALONE_CREDIT_BILLING_ENABLED must be true or false.');
  }
  const enabled = rawFlag === 'true';
  const pricing: CreditPricingConfig = {
    priceMinor: integer('STANDALONE_CREDIT_PRICE_MINOR', 200),
    freeGrant: integer('STANDALONE_FREE_GRANT', 30),
    purchaseMin: integer('STANDALONE_PURCHASE_MIN', 100),
    purchaseMax: integer('STANDALONE_PURCHASE_MAX', 5000),
    purchaseStep: integer('STANDALONE_PURCHASE_STEP', 50),
    lowBalanceThreshold: integer('STANDALONE_LOW_BALANCE_THRESHOLD', 10, 0),
  };
  if (
    pricing.purchaseMin > pricing.purchaseMax ||
    pricing.purchaseMin % pricing.purchaseStep !== 0 ||
    pricing.purchaseMax % pricing.purchaseStep !== 0
  ) {
    errors.push(
      'STANDALONE_PURCHASE_MIN/MAX must be ordered multiples of STANDALONE_PURCHASE_STEP.',
    );
  }
  if (pricing.purchaseMax * pricing.priceMinor > MAX_DATABASE_INTEGER) {
    errors.push(
      'STANDALONE_PURCHASE_MAX times STANDALONE_CREDIT_PRICE_MINOR exceeds database money bounds.',
    );
  }

  const finish = () => {
    if (errors.length) {
      throw new Error(
        `Invalid Standalone billing configuration:\n - ${errors.join('\n - ')}`,
      );
    }
  };
  if (!enabled) {
    finish();
    return { enabled: false, ...pricing };
  }

  const required = (key: string): string => {
    const value = read(key);
    if (!value || placeholder(value)) {
      errors.push(
        `${key} requires a non-placeholder value when billing is enabled.`,
      );
    }
    return value;
  };
  const mode = required('PAYMOB_MODE');
  if (mode !== 'test' && mode !== 'live')
    errors.push('PAYMOB_MODE must be test or live.');
  const url = (key: string): string => {
    const value = required(key);
    try {
      const parsed = new URL(value);
      if (
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        parsed.search ||
        !['https:', 'http:'].includes(parsed.protocol) ||
        (parsed.protocol !== 'https:' &&
          (mode !== 'test' ||
            !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) ||
        (mode === 'live' &&
          (!publicHostname(parsed.hostname) ||
            /(?:^|[.-])(test|sandbox)(?:[.-]|$)/i.test(parsed.hostname))) ||
        /(^|\.)example\.(com|org|net)$|\.(invalid|example)$/i.test(
          parsed.hostname,
        )
      ) {
        errors.push(
          `${key} must be a safe URL; live billing requires a public HTTPS hostname without credentials, query, or fragment.`,
        );
      }
      if (
        key === 'PAYMOB_CALLBACK_URL' &&
        parsed.pathname.replace(/\/$/, '') !== '/api/webhooks/payments/paymob'
      ) {
        errors.push(
          'PAYMOB_CALLBACK_URL must use /api/webhooks/payments/paymob.',
        );
      }
    } catch {
      errors.push(`${key} must be a valid URL.`);
    }
    return value;
  };
  const secretKey = required('PAYMOB_SECRET_KEY');
  const publicKey = required('PAYMOB_PUBLIC_KEY');
  const hmacSecret = required('PAYMOB_HMAC_SECRET');
  for (const key of [
    'PAYMOB_SECRET_KEY',
    'PAYMOB_PUBLIC_KEY',
    'PAYMOB_CARD_INTEGRATION_ID',
    'PAYMOB_WALLET_INTEGRATION_ID',
  ]) {
    const value = read(key);
    const marker = /(?:^|[_-])(test|live)(?:[_-]|$)/i
      .exec(value)?.[1]
      ?.toLowerCase();
    if (marker && marker !== mode)
      errors.push(`${key} conflicts with PAYMOB_MODE.`);
  }
  const cardIntegrationId = required('PAYMOB_CARD_INTEGRATION_ID');
  const walletIntegrationId = required('PAYMOB_WALLET_INTEGRATION_ID');
  for (const key of [
    'PAYMOB_CARD_INTEGRATION_ID',
    'PAYMOB_WALLET_INTEGRATION_ID',
  ]) {
    if (
      !/^[a-z0-9_-]+$/i.test(read(key)) ||
      /^(?:0+|test|live)$/i.test(read(key))
    ) {
      errors.push(`${key} must be a non-placeholder provider identifier.`);
    }
  }
  if (cardIntegrationId === walletIntegrationId) {
    errors.push(
      'PAYMOB_CARD_INTEGRATION_ID and PAYMOB_WALLET_INTEGRATION_ID must differ.',
    );
  }
  const paymob: PaymobConfiguration = {
    mode: mode as PaymentMode,
    baseUrl: url('PAYMOB_BASE_URL'),
    callbackUrl: url('PAYMOB_CALLBACK_URL'),
    returnUrl: url('PAYMOB_RETURN_URL'),
    secretKey,
    publicKey,
    hmacSecret,
    cardIntegrationId,
    walletIntegrationId,
    checkoutExpirationSeconds: integer('PAYMOB_CHECKOUT_EXPIRATION_SECONDS'),
  };
  finish();
  return { enabled: true, ...pricing, paymob };
}
