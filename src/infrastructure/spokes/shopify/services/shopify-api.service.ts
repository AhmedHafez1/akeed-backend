import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { integrations } from 'src/infrastructure/database';
import { decryptToken } from '../../../../shared/utils/token-encryption.util';
import {
  type AppSubscriptionCancelResponse,
  type AppSubscriptionCreateResponse,
  type AppSubscriptionLineItemsResponse,
  type AppSubscriptionStatusResponse,
  type AppUsageRecordCreateResponse,
  buildSubscriptionLineItems,
  CANCEL_APP_SUBSCRIPTION_MUTATION,
  CREATE_APP_SUBSCRIPTION_MUTATION,
  CREATE_USAGE_RECORD_MUTATION,
  GET_APP_SUBSCRIPTION_STATUS_QUERY,
  GET_SUBSCRIPTION_LINE_ITEMS_QUERY,
  getRequestId,
  type GraphQLErrorItem,
  type GraphQLUserError,
  GET_SHOP_NAME_QUERY,
  type ShopNameResponse,
  TAGS_ADD_MUTATION,
  type TagsAddResponse,
  throwIfGraphQLErrors,
  throwIfUserErrors,
  toAppSubscriptionGid,
  toOrderGid,
  validateUsageBillingPayload,
} from './shopify-api.service.helpers';

interface CreateRecurringApplicationChargeInput {
  name: string;
  amount: number;
  currencyCode: string;
  cappedAmount?: number;
  usageTerms?: string;
  returnUrl: string;
  test: boolean;
}

interface AppSubscriptionStatusResult {
  id: string;
  status: string;
}

@Injectable()
export class ShopifyApiService {
  private readonly logger = new Logger(ShopifyApiService.name);

  constructor(
    private readonly _httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async addOrderTag(
    integration: typeof integrations.$inferSelect,
    orderId: string,
    tag: string,
  ): Promise<void> {
    const orderGid = toOrderGid(orderId);

    try {
      const response = await this.executeGraphql<TagsAddResponse>(
        integration,
        TAGS_ADD_MUTATION,
        {
          id: orderGid,
          tags: [tag],
        },
      );

      this.logGraphQLResponseIssues({
        operation: 'tagsAdd',
        graphQLErrors: response.data.errors,
        userErrors: response.data.data?.tagsAdd?.userErrors,
        headers: response.headers,
      });

      const reqId = getRequestId(response.headers);
      this.logger.log(
        `Successfully added tag '${tag}' to order ${orderGid} on ${integration.platformStoreUrl} (requestId=${reqId ?? 'n/a'})`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to add tag to order: ${message}`, stack);
      throw error;
    }
  }

  async getShopName(
    integration: typeof integrations.$inferSelect,
  ): Promise<string> {
    const response = await this.executeGraphql<ShopNameResponse>(
      integration,
      GET_SHOP_NAME_QUERY,
    );

    throwIfGraphQLErrors(response.data.errors, 'Shopify GraphQL errors');

    const shopName = response.data.data?.shop?.name?.trim();
    if (!shopName) {
      throw new Error('Shopify did not return a shop name');
    }

    return shopName;
  }

  async createRecurringApplicationCharge(
    integration: typeof integrations.$inferSelect,
    payload: CreateRecurringApplicationChargeInput,
  ): Promise<string> {
    validateUsageBillingPayload(payload);
    const lineItems = buildSubscriptionLineItems(payload);

    const response = await this.executeGraphql<AppSubscriptionCreateResponse>(
      integration,
      CREATE_APP_SUBSCRIPTION_MUTATION,
      {
        name: payload.name,
        returnUrl: payload.returnUrl,
        test: payload.test,
        lineItems,
      },
    );

    throwIfGraphQLErrors(response.data.errors, 'Shopify billing errors');
    throwIfUserErrors(
      response.data.data?.appSubscriptionCreate?.userErrors,
      'Shopify billing validation failed',
    );

    const confirmationUrl =
      response.data.data?.appSubscriptionCreate?.confirmationUrl;
    if (!confirmationUrl) {
      throw new Error('Shopify billing did not return a confirmation URL');
    }

    return confirmationUrl;
  }

  async getAppSubscriptionStatus(
    integration: typeof integrations.$inferSelect,
    chargeId: string,
  ): Promise<AppSubscriptionStatusResult> {
    const subscriptionId = toAppSubscriptionGid(chargeId);

    const response = await this.executeGraphql<AppSubscriptionStatusResponse>(
      integration,
      GET_APP_SUBSCRIPTION_STATUS_QUERY,
      { id: subscriptionId },
    );

    throwIfGraphQLErrors(
      response.data.errors,
      'Shopify subscription status errors',
    );

    const node = response.data.data?.node;
    if (!node?.id || !node.status) {
      throw new Error('Shopify did not return subscription status');
    }

    return {
      id: node.id,
      status: node.status,
    };
  }

  async cancelAppSubscription(
    integration: typeof integrations.$inferSelect,
    subscriptionId: string,
    prorate = true,
  ): Promise<void> {
    const gid = toAppSubscriptionGid(subscriptionId);

    const response = await this.executeGraphql<AppSubscriptionCancelResponse>(
      integration,
      CANCEL_APP_SUBSCRIPTION_MUTATION,
      { id: gid, prorate },
    );

    throwIfGraphQLErrors(
      response.data.errors,
      'Shopify subscription cancellation errors',
    );
    throwIfUserErrors(
      response.data.data?.appSubscriptionCancel?.userErrors,
      'Shopify subscription cancellation validation failed',
    );

    const cancelledStatus =
      response.data.data?.appSubscriptionCancel?.appSubscription?.status;
    this.logger.log(
      `Cancelled subscription ${gid} (status=${cancelledStatus ?? 'unknown'}, prorate=${prorate})`,
    );
  }

  async reportUsageCharge(
    integration: typeof integrations.$inferSelect,
    subscriptionId: string,
    amount: number,
    currencyCode: string,
    description: string,
  ): Promise<void> {
    const gid = toAppSubscriptionGid(subscriptionId);

    // 1. Query subscription for the usage pricing line item ID
    const lineItemsResponse =
      await this.executeGraphql<AppSubscriptionLineItemsResponse>(
        integration,
        GET_SUBSCRIPTION_LINE_ITEMS_QUERY,
        { id: gid },
      );

    throwIfGraphQLErrors(
      lineItemsResponse.data.errors,
      'Shopify subscription line items query errors',
    );

    const lineItems = lineItemsResponse.data.data?.node?.lineItems ?? [];
    const usageLineItem = lineItems.find(
      (li) => li.plan.pricingDetails.__typename === 'AppUsagePricing',
    );

    if (!usageLineItem) {
      throw new Error(
        `No usage pricing line item found on subscription ${gid}`,
      );
    }

    // 2. Create the usage record
    const response = await this.executeGraphql<AppUsageRecordCreateResponse>(
      integration,
      CREATE_USAGE_RECORD_MUTATION,
      {
        subscriptionLineItemId: usageLineItem.id,
        price: { amount, currencyCode },
        description,
      },
    );

    throwIfGraphQLErrors(
      response.data.errors,
      'Shopify usage record creation errors',
    );
    throwIfUserErrors(
      response.data.data?.appUsageRecordCreate?.userErrors,
      'Shopify usage record validation failed',
    );

    this.logger.log(
      `Usage record created for subscription ${gid}: ${amount} ${currencyCode}`,
    );
  }

  private async executeGraphql<T>(
    integration: typeof integrations.$inferSelect,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<AxiosResponse<T>> {
    const accessToken = this.getAccessTokenOrThrow(integration);

    return await firstValueFrom(
      this._httpService.post<T>(
        this.getGraphqlUrl(integration.platformStoreUrl),
        {
          query,
          variables,
        },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        },
      ),
    );
  }

  private logGraphQLResponseIssues(params: {
    operation: string;
    graphQLErrors?: GraphQLErrorItem[];
    userErrors?: GraphQLUserError[];
    headers?: AxiosResponse['headers'];
  }): void {
    const requestId = getRequestId(params.headers);

    if (params.graphQLErrors && params.graphQLErrors.length > 0) {
      this.logger.error(
        `GraphQL Errors (${params.operation}, requestId=${requestId ?? 'n/a'}): ${JSON.stringify(params.graphQLErrors)}`,
      );
    }

    if (params.userErrors && params.userErrors.length > 0) {
      this.logger.error(
        `User Errors (${params.operation}, requestId=${requestId ?? 'n/a'}): ${JSON.stringify(params.userErrors)}`,
      );
    }
  }

  private getAccessTokenOrThrow(
    integration: typeof integrations.$inferSelect,
  ): string {
    if (integration.accessToken) {
      const encryptionKey = this.configService.get<string>(
        'SHOPIFY_TOKEN_ENCRYPTION_KEY',
      );

      if (!encryptionKey) {
        throw new Error('Missing SHOPIFY_TOKEN_ENCRYPTION_KEY');
      }

      return decryptToken(integration.accessToken, encryptionKey);
    }

    this.logger.error(
      `Missing token for domain: ${integration.platformStoreUrl}`,
    );
    throw new Error(
      `Missing token for domain: ${integration.platformStoreUrl}`,
    );
  }

  private getGraphqlUrl(shopDomain: string): string {
    const apiVersion =
      this.configService.get<string>('SHOPIFY_API_VERSION') ?? '2026-01';
    return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  }
}
