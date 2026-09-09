export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');

export type PaymentMode = 'test' | 'live';
export type PurchaseStatus =
  | 'pending'
  | 'successful'
  | 'failed'
  | 'canceled'
  | 'expired'
  | 'refunded';
export type DisputeStatus = 'none' | 'open' | 'lost' | 'won';

export interface PaymentReference {
  reference: string;
  providerIntentionId?: string;
  providerOrderId?: string;
  providerTransactionId?: string;
}

export interface CreateCheckoutInput {
  reference: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  currency: string;
  expiresAt: string;
}

export type CheckoutResult =
  | {
      outcome: 'created';
      payment: PaymentReference;
      checkoutUrl: string;
      expiresAt: string;
    }
  | { outcome: 'rejected' | 'unknown'; code: string };

export type PaymentInquiryResult =
  | {
      outcome: 'found';
      payment: PaymentReference;
      mode: PaymentMode;
      status: PurchaseStatus;
      disputeStatus: DisputeStatus;
      totalMinor: number;
      currency: string;
      refundedMinor: number;
    }
  | { outcome: 'not_found' | 'unknown'; code: string };

export interface PaymentsPort {
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  inquire(input: PaymentReference): Promise<PaymentInquiryResult>;
}

/** Where a provider fact reached us from. Only an inquiry may confirm expiry. */
export type ProviderEventSource = 'callback' | 'inquiry';

/**
 * What a provider fact means for a purchase, independent of which provider
 * reported it or how it was encoded.
 */
export type PurchaseSignal =
  | 'success'
  | 'pending'
  | 'decline'
  | 'cancel'
  | 'void'
  | 'expiry_confirmed'
  | 'refund'
  | 'chargeback_open'
  | 'chargeback_lost'
  | 'chargeback_won';

/**
 * One provider fact, normalized by the spoke and safe to persist.
 *
 * `fingerprint` is derived from provider facts alone and never from the arrival
 * channel, so the same transaction seen through a callback and through an
 * inquiry collides on `payment_event_fingerprint_key` and the second arrival is
 * a proven no-op rather than a second grant.
 */
export interface NormalizedProviderEvent {
  provider: string;
  source: ProviderEventSource;
  reference: string;
  signal: PurchaseSignal;
  payment: PaymentReference;
  amountMinor: number;
  currency: string;
  integrationId: string;
  mode: PaymentMode;
  /** Cumulative refunded amount reported by the provider, not a delta. */
  refundedMinorTotal?: number;
  /** Provider refund or dispute identifier; the reversal's idempotency key. */
  sourceReference?: string;
  fingerprint: string;
  payloadHash: string;
  /** Sanitized provider decline reason, lower snake case. */
  errorCode?: string;
}
