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
