import { createHash, randomUUID } from 'node:crypto';
import type {
  CheckoutResult,
  CreateCheckoutInput,
  NormalizedProviderEvent,
  PaymentInquiryResult,
  PaymentReference,
  PaymentsPort,
  PurchaseSignal,
} from '../../src/shared/ports/payments.port';

/**
 * A scriptable `PaymentsPort`.
 *
 * The contract suite exercises the database -- transactions, unique indexes,
 * triggers -- so the provider is the one part that should not be real. This
 * double lets a test say "the next checkout times out" or "the inquiry finds a
 * settled payment" without an HTTP layer, while producing events whose
 * fingerprints follow the same rule the Paymob adapter follows: derived from
 * provider facts, never from the arrival channel.
 */
/** Reference is always the harness's, so a case only names the parts it varies. */
export type FakeEventOverrides = Omit<
  Partial<NormalizedProviderEvent>,
  'payment'
> & { payment?: Partial<PaymentReference> };

export interface FakePaymentsPort extends PaymentsPort {
  /** Scripts the outcome of the next `createCheckout` call. */
  nextCheckout(result: CheckoutResult | 'rejected' | 'unknown'): void;
  /** Scripts the outcome of the next `inquire` call. */
  nextInquiry(result: PaymentInquiryResult): void;
  /** Builds the event a callback for this reference would carry. */
  event(
    reference: string,
    overrides?: FakeEventOverrides,
  ): NormalizedProviderEvent;
  /** A `found` inquiry result carrying the matching event. */
  foundInquiry(
    reference: string,
    overrides?: FakeEventOverrides,
  ): PaymentInquiryResult;
  readonly checkouts: CreateCheckoutInput[];
  readonly inquiries: PaymentReference[];
}

export function fakePaymentsPort(): FakePaymentsPort {
  const checkouts: CreateCheckoutInput[] = [];
  const inquiries: PaymentReference[] = [];
  const checkoutQueue: (CheckoutResult | 'rejected' | 'unknown')[] = [];
  const inquiryQueue: PaymentInquiryResult[] = [];

  /**
   * Same rule as the Paymob adapter: provider facts only. Two arrivals for one
   * transaction therefore collide on `payment_event_fingerprint_key`.
   */
  function event(
    reference: string,
    overrides: FakeEventOverrides = {},
  ): NormalizedProviderEvent {
    const signal: PurchaseSignal = overrides.signal ?? 'success';
    const transactionId = overrides.payment?.providerTransactionId ?? 'txn-1';
    const parts = [
      'paymob',
      signal,
      transactionId,
      reference,
      String(overrides.amountMinor ?? 20000),
      String(overrides.refundedMinorTotal ?? ''),
      overrides.sourceReference ?? '',
    ].join('|');
    return {
      provider: 'paymob',
      source: 'callback',
      reference,
      signal,
      amountMinor: 20000,
      currency: 'EGP',
      integrationId: 'card1',
      mode: 'test',
      fingerprint: createHash('sha256').update(parts).digest('hex'),
      payloadHash: createHash('sha256')
        .update(`${parts}|payload`)
        .digest('hex'),
      ...overrides,
      // The reference is the harness's, never an override's.
      payment: {
        reference,
        providerTransactionId: transactionId,
        ...overrides.payment,
      },
    };
  }

  return {
    checkouts,
    inquiries,
    nextCheckout(result) {
      checkoutQueue.push(result);
    },
    nextInquiry(result) {
      inquiryQueue.push(result);
    },
    event,
    foundInquiry(reference, overrides = {}) {
      const inquired = event(reference, { ...overrides, source: 'inquiry' });
      return {
        outcome: 'found',
        payment: inquired.payment,
        mode: 'test',
        status: 'successful',
        disputeStatus: 'none',
        totalMinor: inquired.amountMinor,
        currency: inquired.currency,
        refundedMinor: inquired.refundedMinorTotal ?? 0,
        event: inquired,
      };
    },
    createCheckout(input) {
      checkouts.push(input);
      const scripted = checkoutQueue.shift();
      if (scripted === 'rejected')
        return Promise.resolve({
          outcome: 'rejected',
          code: 'provider_rejected',
        });
      if (scripted === 'unknown')
        return Promise.resolve({
          outcome: 'unknown',
          code: 'provider_unavailable',
        });
      return Promise.resolve(
        scripted ?? {
          outcome: 'created',
          payment: {
            reference: input.reference,
            providerIntentionId: `int-${randomUUID()}`,
            providerOrderId: `ord-${randomUUID()}`,
          },
          checkoutUrl: `http://localhost:9000/unifiedcheckout/?clientSecret=cs-${randomUUID()}`,
          expiresAt: input.expiresAt,
        },
      );
    },
    inquire(input) {
      inquiries.push(input);
      return Promise.resolve(
        inquiryQueue.shift() ?? { outcome: 'not_found', code: 'not_found' },
      );
    },
  };
}
