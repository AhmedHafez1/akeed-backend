import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { integrations } from 'src/infrastructure/database';
import {
  type AppSubscriptionCreateResponse,
  type AppSubscriptionStatusResponse,
  buildSubscriptionLineItems,
  CREATE_APP_SUBSCRIPTION_MUTATION,
  GET_APP_SUBSCRIPTION_STATUS_QUERY,
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

export interface CreateRecurringApplicationChargeInput {
  name: string;
  amount: number;
  currencyCode: string;
  cappedAmount?: number;
  usageTerms?: string;
  returnUrl: string;
  test: boolean;
}

export interface AppSubscriptionStatusResult {
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
      return integration.accessToken;
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
