import type { PlatformType } from '../../../shared/interfaces/commerce-source.interface';

/**
 * What became of an order-update event. A skip carries a stable code that is
 * recorded on the event: no provider text, no customer data.
 */
export type WebhookOrderUpdateResult =
  | { handled: true }
  | { skipped: true; reason: string };

/**
 * Strategy for a platform's order-update events (a status change made in the
 * store). The processor has already matched the event to an active source; the
 * handler is given that trusted identity and must act only on orders that
 * belong to it, never on an id the payload names for another source.
 *
 * A platform without a handler keeps its events unhandled, as before.
 */
export interface WebhookOrderUpdateHandler {
  readonly platform: PlatformType;

  handleOrderUpdate(
    rawPayload: Record<string, unknown>,
    integrationId: string,
    orgId: string,
  ): Promise<WebhookOrderUpdateResult>;
}

/** DI token used for multi-provider injection of order-update handlers. */
export const WEBHOOK_ORDER_UPDATE_HANDLERS = Symbol(
  'WEBHOOK_ORDER_UPDATE_HANDLERS',
);
