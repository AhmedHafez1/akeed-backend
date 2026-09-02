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
}

export interface SubscriptionStatusResult {
  id: string;
  status: string;
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
