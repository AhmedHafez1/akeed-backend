export const META_WEBHOOK_QUEUE = 'meta-webhook-processing';

export const META_WEBHOOK_PROCESS_JOB = 'process';
export const META_WEBHOOK_SWEEP_JOB = 'sweep';
export const META_WEBHOOK_PURGE_JOB = 'purge';
export const META_WEBHOOK_SWEEP_SCHEDULER = 'meta-webhook-sweep';
export const META_WEBHOOK_PURGE_SCHEDULER = 'meta-webhook-purge';
export const CUSTOMER_MESSAGES_PURGE_JOB = 'customer-messages-purge';
export const CUSTOMER_MESSAGES_PURGE_SCHEDULER =
  'customer-messages-daily-purge';
export const CUSTOMER_MESSAGES_PURGE_EVERY_MS = 24 * 60 * 60_000;

export const META_WEBHOOK_SWEEP_EVERY_MS = 60_000;
export const META_WEBHOOK_PURGE_EVERY_MS = 60 * 60_000;

/**
 * Tries an event gets, and the first wait between them. Doubling from 15
 * seconds spreads ten tries over about two hours, so a short database outage
 * doesn't use them up. Past that the row is still there: the sweep finds it.
 */
export const META_WEBHOOK_MAX_ATTEMPTS = 10;
export const META_WEBHOOK_BACKOFF_MS = 15_000;

/** How long a run holds an event; a crash frees it after this. */
export const META_WEBHOOK_LEASE_MS = 10 * 60_000;
/** How long a queued event waits before the sweep looks at it. */
export const META_WEBHOOK_ENQUEUE_GRACE_MS = 60_000;
/** Extra time a retry's own job gets before the sweep steps in. */
export const META_WEBHOOK_RETRY_GRACE_MS = 2 * 60_000;
/** How long the sweep leaves an event it has just queued. */
export const META_WEBHOOK_SWEEP_RETRY_MS = 5 * 60_000;
export const META_WEBHOOK_SWEEP_BATCH = 100;
export const META_WEBHOOK_SWEEP_MAX_BATCHES = 10;

export const META_WEBHOOK_PAYLOAD_RETENTION_DAYS = 14;
export const META_WEBHOOK_ROW_RETENTION_DAYS = 30;

/** Job data holds the row's id only, so no customer data sits in Redis. */
export interface MetaWebhookJobPayload {
  eventId: string;
}
