import type { StandaloneIngestionChannel } from '../../shared/commerce/standalone-order-envelope';

export type {
  CanonicalOrderExtras,
  CanonicalOrderInput,
  StandaloneIngestionChannel,
} from '../../shared/commerce/standalone-order-envelope';

/** The trusted, already-resolved Standalone source an order is accepted into. */
export interface StandaloneIngestionContext {
  orgId: string;
  source: { id: string; platformStoreUrl: string };
}

export interface AcceptOneOptions {
  channel: StandaloneIngestionChannel;
  /** Channel-local key; the service namespaces it per channel. */
  idempotencyKey: string;
  /**
   * Accept without dispatching. The event stays invisible to every dispatch
   * path until it is released; `groupId` is the batch it belongs to.
   */
  hold?: { groupId: string };
  /** Channel metadata stored beside the order in `rawPayload`. */
  envelopeExtras?: Record<string, unknown>;
}

export interface AcceptOneResult {
  orderId: string;
  eventId: string;
  verificationId?: string;
  duplicate: boolean;
  held: boolean;
}
