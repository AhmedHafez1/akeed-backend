import type { CreditDenialCode } from '../../shared/billing/credit-eligibility';
import type {
  EntitlementAvailability,
  EntitlementDenialReason,
  UsageAccountingMode,
} from '../../shared/billing/entitlement';

/**
 * The order a retry is about to re-send. Only the retry path supplies it: a
 * new order is judged by its channel adapter before it exists.
 */
export interface SendReadinessOrder {
  orgId: string;
  integrationId: string;
  externalOrderId: string;
  orderNumber: string | null;
  customerPhone: string;
  customerName: string | null;
  totalPrice: string | null;
  currency: string | null;
  paymentMethod: string | null;
  rawPayload: unknown;
}

export interface SendReadinessOptions {
  /**
   * How many first messages must be affordable. The manual paths send one;
   * an import start needs its whole held count.
   */
  required: number;
  /** Adds the order-eligibility gate (payment method) for a retry. */
  order?: SendReadinessOrder;
  /**
   * `first` (default) stops reading billing state at the first blocker, which
   * is what the single-order paths have always done. `all` reads everything so
   * a quote can list every blocker and the balance at once.
   */
  mode?: 'first' | 'all';
}

/**
 * Channel-neutral reasons a source cannot send right now. Each channel maps
 * these onto its own error vocabulary; the rules themselves live only in
 * `StandaloneSendReadinessService`.
 */
export type SendReadinessBlocker =
  | { kind: 'source_inactive' }
  | { kind: 'setup_incomplete' }
  | { kind: 'entitlement_required'; reason: EntitlementDenialReason | null }
  | { kind: 'auto_verify_disabled' }
  | { kind: 'order_ineligible'; reason: string }
  | {
      kind: 'credit_denied';
      code: CreditDenialCode;
      /** Present for `INSUFFICIENT_CREDITS`: credits missing to cover `required`. */
      shortfall?: number;
      available?: number;
    }
  | {
      kind: 'slot_unavailable';
      reason: EntitlementAvailability['reason'];
      consumedCount: number;
      includedLimit: number;
      /** Periodic plans only: slots left in the current period. */
      slotsRemaining?: number;
    };

export interface SendReadinessSnapshot {
  accountingMode: UsageAccountingMode;
  /** Prepaid-credit sources only. */
  creditsAvailable: number | null;
  /** Periodic-plan sources only. */
  slotsRemaining: number | null;
}

export interface SendReadiness {
  ready: boolean;
  blockers: SendReadinessBlocker[];
  snapshot: SendReadinessSnapshot;
}
