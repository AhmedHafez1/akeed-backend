import type { StoreConnection } from './store-platform.port';
export const SUBSCRIPTION_BILLING_PORT = Symbol('SUBSCRIPTION_BILLING_PORT');

export type BillingConnection = StoreConnection;

export interface CreateSubscriptionInput {
  name: string;
  amount: number;
  currencyCode: string;
  cappedAmount?: number;
  usageTerms?: string;
  returnUrl: string;
  test: boolean;
  /**
   * Replace the current subscription as soon as the merchant approves, even
   * when the new one is identical (a renewal), instead of at the next cycle.
   */
  replaceImmediately?: boolean;
  /**
   * Free days before Shopify's first charge, counted from the merchant's
   * approval. Used so a store in a paid-through period is not charged twice
   * for days it already paid for.
   */
  trialDays?: number;
}

export interface SubscriptionStatusResult {
  id: string;
  status: string;
  /** The subscription's trial length in days, when Shopify returns it. */
  trialDays?: number;
}

export interface SubscriptionBillingPort {
  createRecurringApplicationCharge(
    integration: BillingConnection,
    input: CreateSubscriptionInput,
  ): Promise<string>;
  getAppSubscriptionStatus(
    integration: BillingConnection,
    chargeId: string,
  ): Promise<SubscriptionStatusResult>;
  cancelAppSubscription(
    integration: BillingConnection,
    subscriptionId: string,
    prorate?: boolean,
  ): Promise<void>;
  reportUsageCharge(
    integration: BillingConnection,
    subscriptionId: string,
    amount: number,
    currencyCode: string,
    description: string,
  ): Promise<void>;
}
