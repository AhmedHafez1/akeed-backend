import { NormalizedOrder } from '../../../shared/interfaces/order.interface';
import { PlatformType } from '../webhook-queue.constants';

/**
 * Strategy interface for platform-specific webhook normalisation.
 *
 * Each e-commerce platform ships a different webhook schema.  Implementing
 * this interface lets us add new platforms without touching the processor
 * or any queue infrastructure.
 *
 * Implementations MUST be stateless — they receive everything they need
 * via method arguments.
 */
export interface WebhookOrderNormalizer {
  /** The platform this normalizer handles. */
  readonly platform: PlatformType;

  /**
   * Convert a raw webhook payload into a `NormalizedOrder`.
   *
   * @returns `null` when the payload cannot be normalised (e.g. missing phone).
   *          The processor will log a warning and skip the job without retrying.
   */
  normalizeOrder(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): NormalizedOrder | null;
}

/** DI token used for multi-provider injection of normalizers. */
export const WEBHOOK_ORDER_NORMALIZERS = Symbol('WEBHOOK_ORDER_NORMALIZERS');
