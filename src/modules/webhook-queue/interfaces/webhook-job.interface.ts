import { PlatformType, WebhookJobType } from '../webhook-queue.constants';

/**
 * Payload persisted in Redis by the producer and consumed by the processor.
 *
 * Design constraints:
 *  - Must be JSON-serialisable (no class instances, Dates as ISO strings).
 *  - Kept minimal — heavy data (rawPayload) is embedded so we never
 *    need a DB round-trip inside the hot path of the consumer.
 */
export interface WebhookJobPayload {
  /** Unique ID of the persisted webhook_events row (for correlation). */
  webhookEventId: string;

  /** E-commerce platform that produced this event. */
  platform: PlatformType;

  /** Discriminated job type — lets the processor choose the right handler. */
  jobType: WebhookJobType;

  /** Idempotency key provided by the platform (e.g. X-Shopify-Webhook-Id). */
  idempotencyKey: string;

  /** Store domain / identifier as reported by the platform. */
  storeDomain: string;

  /** Raw webhook body — opaque to the queue, interpreted by normalizers. */
  rawPayload: Record<string, unknown>;

  /** ISO-8601 timestamp of when the event was received by our ingestion layer. */
  receivedAt: string;
}
