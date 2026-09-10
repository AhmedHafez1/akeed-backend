import type { ConfigService } from '@nestjs/config';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../src/shared/config/standalone-credit-billing.config';
import {
  parseStandaloneBillingOperationsConfig,
  STANDALONE_BILLING_OPERATIONS_CONFIG,
} from '../../src/shared/config/standalone-billing-operations.config';
import {
  parseStandaloneBillingObservabilityConfig,
  STANDALONE_BILLING_OBSERVABILITY_CONFIG,
} from '../../src/shared/config/standalone-billing-observability.config';

/**
 * Builds the same validated billing object `validateEnv` puts on the
 * configuration, so contract suites exercise the real parser instead of
 * hand-rolling a shape the application would never produce.
 */
export function standaloneCreditBillingConfigService(
  environment: Record<string, string> = {},
): ConfigService {
  const values: Record<string, unknown> = {
    ...environment,
    [STANDALONE_CREDIT_BILLING_CONFIG]:
      parseStandaloneCreditBillingConfig(environment),
    [STANDALONE_BILLING_OPERATIONS_CONFIG]:
      parseStandaloneBillingOperationsConfig(environment),
    [STANDALONE_BILLING_OBSERVABILITY_CONFIG]:
      parseStandaloneBillingObservabilityConfig(environment),
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}
