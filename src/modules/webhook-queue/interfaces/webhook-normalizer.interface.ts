import { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';

/**
 * A payload that is understood but must not become an order. The reason is
 * recorded on the event, so it has to be a stable code that is safe to show:
 * no provider text, no customer data.
 */
export interface WebhookNormalizationSkip {
  skipped: true;
  reason: string;
}

export type WebhookNormalizationResult =
  | NormalizedOrder
  | WebhookNormalizationSkip
  | null;

/**
 * Strategy interface for platform-specific webhook normalisation.
 *
 * Each e-commerce platform ships a different webhook schema.  Implementing
 * this interface lets us add new platforms without touching the processor
 * or any queue infrastructure.
 *
 * Implementations keep no state between calls. One that needs its source's
 * settings loads them by the `integrationId` and `orgId` it is given, never
 * by anything in the payload.
 */
export interface WebhookOrderNormalizer {
  /** The platform this normalizer handles. */
  readonly platform: PlatformType;

  /**
   * Convert a raw webhook payload into a `NormalizedOrder`.
   *
   * @returns `null` when the payload cannot be normalised (e.g. missing phone),
   *          or a skip with its reason. The processor skips the job without
   *          retrying. Throwing means "try again": a `RetryAfterError`
   *          reschedules the job for the delay it names.
   */
  normalizeOrder(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): WebhookNormalizationResult | Promise<WebhookNormalizationResult>;
}

/** DI token used for multi-provider injection of normalizers. */
export const WEBHOOK_ORDER_NORMALIZERS = Symbol('WEBHOOK_ORDER_NORMALIZERS');
