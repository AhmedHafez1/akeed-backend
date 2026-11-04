export const WHATSAPP_CONNECTION_SETUP_QUEUE = 'whatsapp-connection-setup';

/** One attempt at a connection's setup. */
export const CONNECTION_SETUP_JOB = 'connection-setup';
export const CONNECTION_HEALTH_JOB = 'connection-health';
export const CONNECTION_HEALTH_SWEEP_JOB = 'connection-health-sweep';
/** Finds setups that are due and queues them. */
export const CONNECTION_SETUP_SWEEP_JOB = 'connection-setup-sweep';
/** Reconciles one connection's templates with its account. */
export const CONNECTION_TEMPLATE_SYNC_JOB = 'connection-template-sync';
/** Queues a template sync for every connected account. */
export const CONNECTION_TEMPLATE_SYNC_ALL_JOB = 'connection-template-sync-all';

export const CONNECTION_SETUP_SWEEP_SCHEDULER =
  'whatsapp-connection-setup-sweep';
export const CONNECTION_TEMPLATE_SYNC_SCHEDULER =
  'whatsapp-connection-template-sync-6h';

/** A setup queued while the queue was down is found within this long. */
export const CONNECTION_SETUP_SWEEP_EVERY_MS = 2 * 60_000;
/** The same 6 hours as Akeed's own template sync. */
export const CONNECTION_TEMPLATE_SYNC_EVERY_MS = 6 * 60 * 60_000;
/** A burst of template webhooks for one account shares one sync. */
export const CONNECTION_TEMPLATE_SYNC_WEBHOOK_DELAY_MS = 60_000;
/** Setups queued per sweep; the rest wait for the next one. */
export const CONNECTION_SETUP_SWEEP_LIMIT = 50;

export interface ConnectionSetupJob {
  connectionId: string;
  signupGeneration: number;
}

export interface ConnectionTemplateSyncJob {
  connectionId: string;
}

export type WhatsappConnectionSetupJobData =
  | { orgId: string; connectionId: string; signupGeneration: number }
  | ConnectionSetupJob
  | ConnectionTemplateSyncJob
  | Record<string, never>;
