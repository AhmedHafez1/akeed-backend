export const STORE_PLATFORM_PORT = Symbol('STORE_PLATFORM_PORT');

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

export interface StorePlatformPort {
  getShopName(integration: any): Promise<string>;
  createRecurringApplicationCharge(
    integration: any,
    input: CreateSubscriptionInput,
  ): Promise<string>;
  getAppSubscriptionStatus(
    integration: any,
    chargeId: string,
  ): Promise<SubscriptionStatusResult>;
  reportUsageCharge(
    integration: any,
    subscriptionId: string,
    amount: number,
    currencyCode: string,
    description: string,
  ): Promise<void>;
}
