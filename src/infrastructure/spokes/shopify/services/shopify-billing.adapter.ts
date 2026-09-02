import { ForbiddenException, Injectable } from '@nestjs/common';
import { ShopifyApiService } from './shopify-api.service';
import type {
  BillingConnection,
  CreateSubscriptionInput,
  SubscriptionBillingPort,
  SubscriptionStatusResult,
} from '../../../../shared/ports/subscription-billing.port';

@Injectable()
export class ShopifyBillingAdapter implements SubscriptionBillingPort {
  constructor(private readonly api: ShopifyApiService) {}

  private assertShopify(integration: BillingConnection): void {
    if (integration.platformType !== 'shopify')
      throw new ForbiddenException(
        'Subscription billing is unavailable for this source',
      );
  }

  async createRecurringApplicationCharge(
    integration: BillingConnection,
    input: CreateSubscriptionInput,
  ) {
    this.assertShopify(integration);
    return this.api.createRecurringApplicationCharge(integration, input);
  }

  async getAppSubscriptionStatus(
    integration: BillingConnection,
    chargeId: string,
  ): Promise<SubscriptionStatusResult> {
    this.assertShopify(integration);
    return this.api.getAppSubscriptionStatus(integration, chargeId);
  }

  async cancelAppSubscription(
    integration: BillingConnection,
    subscriptionId: string,
    prorate?: boolean,
  ) {
    this.assertShopify(integration);
    return this.api.cancelAppSubscription(integration, subscriptionId, prorate);
  }

  async reportUsageCharge(
    integration: BillingConnection,
    subscriptionId: string,
    amount: number,
    currencyCode: string,
    description: string,
  ) {
    this.assertShopify(integration);
    return this.api.reportUsageCharge(
      integration,
      subscriptionId,
      amount,
      currencyCode,
      description,
    );
  }
}
