import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { integrations } from 'src/infrastructure/database';

interface TagsAddResponse {
  data?: {
    tagsAdd?: {
      node?: { id: string };
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string; locations?: unknown; path?: string[] }>;
}

interface ShopNameResponse {
  data?: {
    shop?: {
      name?: string;
    };
  };
  errors?: Array<{ message: string; locations?: unknown; path?: string[] }>;
}

interface AppSubscriptionCreateResponse {
  data?: {
    appSubscriptionCreate?: {
      confirmationUrl?: string;
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string; locations?: unknown; path?: string[] }>;
}

interface AppSubscriptionStatusResponse {
  data?: {
    node?: {
      id?: string;
      status?: string;
    } | null;
  };
  errors?: Array<{ message: string; locations?: unknown; path?: string[] }>;
}

export interface CreateRecurringApplicationChargeInput {
  name: string;
  amount: number;
  currencyCode: string;
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
    // Ensure orderId is not already a GID before wrapping it.
    // If user passes raw ID "123", we make it "gid://shopify/Order/123".
    const gid = orderId.startsWith('gid://')
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    const mutation = `
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    try {
      const response = await this.executeGraphql<TagsAddResponse>(
        integration,
        mutation,
        {
          id: gid,
          tags: [tag],
        },
      );

      this.handleGraphQLErrors(response, 'tagsAdd');

      const reqId = (response.headers?.['x-request-id'] ??
        response.headers?.['X-Request-Id']) as string | undefined;
      this.logger.log(
        `Successfully added tag '${tag}' to order ${gid} on ${integration.platformStoreUrl} (requestId=${reqId ?? 'n/a'})`,
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
    const query = `
      query GetShopName {
        shop {
          name
        }
      }
    `;

    const response = await this.executeGraphql<ShopNameResponse>(
      integration,
      query,
    );

    const graphQLErrors = response.data.errors;
    if (graphQLErrors && graphQLErrors.length > 0) {
      throw new Error(
        `Shopify GraphQL errors: ${graphQLErrors.map((error) => error.message).join('; ')}`,
      );
    }

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
    const mutation = `
      mutation CreateAppSubscription(
        $name: String!
        $lineItems: [AppSubscriptionLineItemInput!]!
        $returnUrl: URL!
        $test: Boolean
      ) {
        appSubscriptionCreate(
          name: $name
          lineItems: $lineItems
          returnUrl: $returnUrl
          test: $test
        ) {
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await this.executeGraphql<AppSubscriptionCreateResponse>(
      integration,
      mutation,
      {
        name: payload.name,
        returnUrl: payload.returnUrl,
        test: payload.test,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: {
                  amount: payload.amount,
                  currencyCode: payload.currencyCode,
                },
                interval: 'EVERY_30_DAYS',
              },
            },
          },
        ],
      },
    );

    const graphQLErrors = response.data.errors;
    if (graphQLErrors && graphQLErrors.length > 0) {
      throw new Error(
        `Shopify billing errors: ${graphQLErrors.map((error) => error.message).join('; ')}`,
      );
    }

    const userErrors =
      response.data.data?.appSubscriptionCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        `Shopify billing validation failed: ${userErrors.map((error) => error.message).join('; ')}`,
      );
    }

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
    const mutation = `
      query GetAppSubscriptionStatus($id: ID!) {
        node(id: $id) {
          ... on AppSubscription {
            id
            status
          }
        }
      }
    `;

    const subscriptionId = chargeId.startsWith('gid://')
      ? chargeId
      : `gid://shopify/AppSubscription/${chargeId}`;

    const response = await this.executeGraphql<AppSubscriptionStatusResponse>(
      integration,
      mutation,
      { id: subscriptionId },
    );

    const graphQLErrors = response.data.errors;
    if (graphQLErrors && graphQLErrors.length > 0) {
      throw new Error(
        `Shopify subscription status errors: ${graphQLErrors.map((error) => error.message).join('; ')}`,
      );
    }

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
    if (!integration.accessToken) {
      this.logger.error(
        `Missing token for domain: ${integration.platformStoreUrl}`,
      );
      throw new Error(
        `Missing token for domain: ${integration.platformStoreUrl}`,
      );
    }

    return await firstValueFrom(
      this._httpService.post<T>(
        this.getGraphqlUrl(integration.platformStoreUrl),
        {
          query,
          variables,
        },
        {
          headers: {
            'X-Shopify-Access-Token': integration.accessToken,
            'Content-Type': 'application/json',
          },
        },
      ),
    );
  }

  private getGraphqlUrl(shopDomain: string): string {
    const apiVersion =
      this.configService.get<string>('SHOPIFY_API_VERSION') ?? '2026-01';
    return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  }

  private handleGraphQLErrors(
    response: AxiosResponse<TagsAddResponse>,
    operation: string,
  ): void {
    const reqId = (response.headers?.['x-request-id'] ??
      response.headers?.['X-Request-Id']) as string | undefined;
    const data: TagsAddResponse = response.data;

    if (data.errors && data.errors.length > 0) {
      this.logger.error(
        `GraphQL Errors (${operation}, requestId=${reqId ?? 'n/a'}): ${JSON.stringify(data.errors)}`,
      );
    }

    const userErrors = data.data?.tagsAdd?.userErrors;
    if (userErrors && userErrors.length > 0) {
      this.logger.error(
        `User Errors (${operation}, requestId=${reqId ?? 'n/a'}): ${JSON.stringify(userErrors)}`,
      );
    }
  }
}
