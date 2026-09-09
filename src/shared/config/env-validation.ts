import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from './standalone-credit-billing.config';

/**
 * Fail-fast validation of the environment the app cannot work without.
 *
 * Nest resolves most secrets lazily, at the moment of first use. For an
 * inbound-webhook secret that is the worst possible timing: the app boots
 * clean, serves traffic, and every Meta callback is rejected by the signature
 * guard — which looks exactly like Meta never calling at all. Checking here
 * turns a silent, permanent data-loss bug into a failed deploy.
 */

/** Required in every environment. */
const REQUIRED_VARS = ['DATABASE_URL'] as const;

/**
 * Required for the WhatsApp round trip. Outbound sending and inbound
 * status/reply callbacks both break without these, so they are validated as
 * one group.
 */
const META_VARS = [
  'WA_ACCESS_TOKEN',
  'WA_PHONE_NUMBER_ID',
  'WA_VERIFY_TOKEN',
  'META_APP_SECRET',
] as const;

/**
 * Values shipped in `.env.example`. Copying that file wholesale is the normal
 * way to set up a local environment, and a placeholder secret that reaches a
 * deployed environment silently breaks inbound webhooks rather than failing
 * loudly, so these are rejected outside development.
 */
const PLACEHOLDER_VALUES = new Set([
  '07d18791af2d3a95ee5086da1d86bcbc',
  'changeme',
  'placeholder',
  'your-secret-here',
]);

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const read = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === 'string' ? value : undefined;
  };

  const nodeEnv = read('NODE_ENV') ?? 'development';
  const isProductionLike = nodeEnv !== 'development' && nodeEnv !== 'test';
  const errors: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (isBlank(read(key))) errors.push(`${key} is required.`);
  }

  // Tests stub the messaging port outright and never reach Meta, so requiring
  // real credentials there would only make the suite need secrets it does not use.
  if (nodeEnv !== 'test') {
    for (const key of META_VARS) {
      const value = read(key);
      if (isBlank(value)) {
        errors.push(
          `${key} is required — without it WhatsApp delivery, read and reply callbacks are silently dropped.`,
        );
        continue;
      }
      if (isProductionLike && PLACEHOLDER_VALUES.has(value!.trim())) {
        errors.push(
          `${key} is still set to the ${'`'}.env.example${'`'} placeholder. Set the real value from the Meta app dashboard.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  }

  return {
    ...config,
    [STANDALONE_CREDIT_BILLING_CONFIG]:
      parseStandaloneCreditBillingConfig(config),
  };
}
