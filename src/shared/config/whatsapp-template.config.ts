export const WHATSAPP_TEMPLATE_CONFIG = 'whatsappTemplates';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * WhatsApp template management (E08). Every switch is off by default.
 *
 * - `syncEnabled` turns on the scheduled and on-demand sync from the
 *   provider and the template webhooks. It needs the WhatsApp Business
 *   Account ID, so `businessAccountId` is required when it is on.
 * - `guardrailEnabled` lets a send use only templates the provider has
 *   approved. It acts only once the environment has synced.
 * - `operationsEnabled` and `operatorIds` name the staff who may trigger
 *   template writes, the sync among them.
 */
export interface WhatsappTemplateConfig {
  syncEnabled: boolean;
  guardrailEnabled: boolean;
  operationsEnabled: boolean;
  operatorIds: ReadonlySet<string>;
  businessAccountId: string | null;
}

export function parseWhatsappTemplateConfig(
  config: Record<string, unknown>,
): WhatsappTemplateConfig {
  const read = (key: string): string =>
    typeof config[key] === 'string' ? config[key].trim() : '';
  const errors: string[] = [];
  const flag = (key: string): boolean => {
    const value = read(key);
    if (value && value !== 'true' && value !== 'false')
      errors.push(`${key} must be true or false.`);
    return value === 'true';
  };
  const syncEnabled = flag('WHATSAPP_TEMPLATE_SYNC_ENABLED');
  const guardrailEnabled = flag('WHATSAPP_TEMPLATE_GUARDRAIL_ENABLED');
  const operationsEnabled = flag('WHATSAPP_TEMPLATE_OPERATIONS_ENABLED');
  const operatorIds = read('WHATSAPP_TEMPLATE_OPERATOR_IDS')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const businessAccountId = read('WA_BUSINESS_ACCOUNT_ID');

  if (operatorIds.some((value) => !UUID_PATTERN.test(value)))
    errors.push(
      'WHATSAPP_TEMPLATE_OPERATOR_IDS must be a comma-separated list of staff user UUIDs.',
    );
  if (operationsEnabled && operatorIds.length === 0)
    errors.push(
      'WHATSAPP_TEMPLATE_OPERATOR_IDS must name at least one staff user when WHATSAPP_TEMPLATE_OPERATIONS_ENABLED=true.',
    );
  if (syncEnabled && !businessAccountId)
    errors.push(
      'WA_BUSINESS_ACCOUNT_ID is required when WHATSAPP_TEMPLATE_SYNC_ENABLED=true.',
    );
  if (businessAccountId && !/^\d{1,32}$/.test(businessAccountId))
    errors.push('WA_BUSINESS_ACCOUNT_ID must be the numeric account ID.');
  if (errors.length)
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  return {
    syncEnabled,
    guardrailEnabled,
    operationsEnabled,
    operatorIds: new Set(operatorIds),
    businessAccountId: businessAccountId || null,
  };
}

/**
 * Reads the object `validateEnv` already parsed at startup. Runtime code must
 * never re-derive these switches from raw environment strings.
 */
export function readWhatsappTemplateConfig(config: {
  get<T>(key: string): T | undefined;
}): WhatsappTemplateConfig {
  const parsed = config.get<WhatsappTemplateConfig>(WHATSAPP_TEMPLATE_CONFIG);
  if (!parsed)
    throw new Error('WhatsApp template configuration was not validated');
  return parsed;
}

export function isWhatsappTemplateOperator(
  config: WhatsappTemplateConfig,
  userId: string,
): boolean {
  return (
    config.operationsEnabled && config.operatorIds.has(userId.toLowerCase())
  );
}
