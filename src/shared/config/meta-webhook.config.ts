export const META_WEBHOOK_CONFIG = 'metaWebhook';

/** How Meta webhooks are taken in. */
export interface MetaWebhookConfig {
  /**
   * On: a signed POST is stored and answered, and a worker processes it. Off:
   * it is processed inside the request. The worker, the sweep and the purge
   * run either way, so stored events still drain after switching back.
   */
  durableEnabled: boolean;
}

export function parseMetaWebhookConfig(
  config: Record<string, unknown>,
): MetaWebhookConfig {
  const raw = config.META_WEBHOOK_DURABLE_ENABLED;
  const flag = typeof raw === 'string' ? raw.trim() : '';
  if (flag && flag !== 'true' && flag !== 'false') {
    throw new Error(
      'Invalid environment configuration:\n - META_WEBHOOK_DURABLE_ENABLED must be true or false.',
    );
  }
  return { durableEnabled: flag === 'true' };
}

export function readMetaWebhookConfig(config: {
  get<T>(key: string): T | undefined;
}): MetaWebhookConfig {
  return (
    config.get<MetaWebhookConfig>(META_WEBHOOK_CONFIG) ?? {
      durableEnabled: false,
    }
  );
}
