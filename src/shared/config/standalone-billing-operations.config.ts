export const STANDALONE_BILLING_OPERATIONS_CONFIG =
  'standaloneBillingOperations';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Who may change Standalone billing state from the staff console.
 *
 * Reading accounts and taking previews needs only the staff role. Applying an
 * adjustment, a dispatch resolution, an inquiry, provider evidence or a
 * projection repair also needs this switch on and the staff member named in
 * the allowlist, so writes can be handed to a few people after a recovery
 * drill rather than to every admin at once.
 */
export interface StandaloneBillingOperationsConfig {
  enabled: boolean;
  operatorIds: ReadonlySet<string>;
}

export function parseStandaloneBillingOperationsConfig(
  config: Record<string, unknown>,
): StandaloneBillingOperationsConfig {
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const flag = read('STANDALONE_BILLING_OPERATIONS_ENABLED');
  if (flag && flag !== 'true' && flag !== 'false')
    throw new Error(
      'Invalid environment configuration:\n - STANDALONE_BILLING_OPERATIONS_ENABLED must be true or false.',
    );
  const operatorIds = read('STANDALONE_BILLING_OPERATOR_IDS')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const enabled = flag === 'true';
  const errors: string[] = [];
  if (operatorIds.some((value) => !UUID_PATTERN.test(value)))
    errors.push(
      'STANDALONE_BILLING_OPERATOR_IDS must be a comma-separated list of staff user UUIDs.',
    );
  if (enabled && operatorIds.length === 0)
    errors.push(
      'STANDALONE_BILLING_OPERATOR_IDS must name at least one staff user when STANDALONE_BILLING_OPERATIONS_ENABLED=true.',
    );
  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return { enabled, operatorIds: new Set(operatorIds) };
}

/**
 * Reads the object `validateEnv` already parsed at startup. Runtime code must
 * never re-derive who may write from raw environment strings.
 */
export function readStandaloneBillingOperationsConfig(config: {
  get<T>(key: string): T | undefined;
}): StandaloneBillingOperationsConfig {
  const operations = config.get<StandaloneBillingOperationsConfig>(
    STANDALONE_BILLING_OPERATIONS_CONFIG,
  );
  if (!operations)
    throw new Error(
      'Standalone billing operations configuration was not validated',
    );
  return operations;
}

export function isStandaloneBillingOperator(
  operations: StandaloneBillingOperationsConfig,
  userId: string,
): boolean {
  return operations.enabled && operations.operatorIds.has(userId.toLowerCase());
}
