import type {
  CommerceCancellationOptions,
  CommerceOutcomeConnection,
} from '../../../../shared/commerce/commerce-outcome';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse, isAxiosError } from 'axios';
import { firstValueFrom, timeout } from 'rxjs';
import { decryptToken } from '../../../../shared/utils/token-encryption.util';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import {
  type AppSubscriptionCancelResponse,
  type AppSubscriptionCreateResponse,
  type AppSubscriptionLineItemsResponse,
  type AppSubscriptionStatusResponse,
  type ActiveAppSubscriptionsResponse,
  type AppUsageRecordCreateResponse,
  buildSubscriptionLineItems,
  CANCEL_APP_SUBSCRIPTION_MUTATION,
  CREATE_TEST_COD_ORDER_MUTATION,
  type CreateTestCodOrderResponse,
  CREATE_APP_SUBSCRIPTION_MUTATION,
  CREATE_USAGE_RECORD_MUTATION,
  GET_APP_SUBSCRIPTION_STATUS_QUERY,
  GET_ACTIVE_APP_SUBSCRIPTIONS_QUERY,
  GET_SUBSCRIPTION_LINE_ITEMS_QUERY,
  getRequestId,
  type GraphQLErrorItem,
  type GraphQLUserError,
  GET_SHOP_NAME_QUERY,
  JOB_STATUS_QUERY,
  type JobStatusResponse,
  ORDER_CANCEL_MUTATION,
  ORDER_CANCELLATION_STATE_QUERY,
  type OrderCancellationStateResponse,
  type CurrentOrderResponse,
  CURRENT_ORDER_QUERY,
  type ShopifyCurrentOrder,
  type OrderCancelResponse,
  type ShopifyOrderCancellationState,
  type ShopNameResponse,
  TAGS_ADD_MUTATION,
  type TagsAddResponse,
  TAGS_REMOVE_MUTATION,
  type TagsRemoveResponse,
  type TestCodOrder,
  throwIfGraphQLErrors,
  throwIfUserErrors,
  toAppSubscriptionGid,
  toOrderGid,
  validateUsageBillingPayload,
} from './shopify-api.service.helpers';
import {
  ShopifyCredentialService,
  type ShopifyAccessToken,
} from './shopify-credential.service';
import {
  isLegacyTokenRejection,
  ShopifyReauthRequiredError,
} from './shopify-offline-token';

interface CreateRecurringApplicationChargeInput {
  name: string;
  amount: number;
  currencyCode: string;
  cappedAmount?: number;
  usageTerms?: string;
  returnUrl: string;
  test: boolean;
  replaceImmediately?: boolean;
  trialDays?: number;
}

interface AppSubscriptionStatusResult {
  id: string;
  status: string;
  trialDays?: number;
}

@Injectable()
export class ShopifyApiService {
  private readonly logger = new Logger(ShopifyApiService.name);

  constructor(
    @Inject(HttpService)
    private readonly _httpService: HttpService,
    @Inject(ConfigService)
    private readonly configService: ConfigService,
    @Optional()
    private readonly credentials?: ShopifyCredentialService,
  ) {}

  async addOrderTag(
    integration: CommerceOutcomeConnection,
    orderId: string,
    tag: string,
    timeoutMs?: number,
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
        timeoutMs,
      );

      this.logGraphQLResponseIssues({
        operation: 'tagsAdd',
        graphQLErrors: response.data.errors,
        userErrors: response.data.data?.tagsAdd?.userErrors,
        headers: response.headers,
      });

      throwIfGraphQLErrors(
        response.data.errors,
        'Shopify order tagging errors',
      );
      throwIfUserErrors(
        response.data.data?.tagsAdd?.userErrors,
        'Shopify order tagging validation failed',
      );
      if (timeoutMs && !response.data.data?.tagsAdd?.node?.id)
        throw new Error('Shopify tag addition outcome unknown');

      const reqId = getRequestId(response.headers);
      this.logger.log(
        buildBackendLog(ShopifyApiService.name, {
          action: 'shopify-order-tag-add',
          outcome: 'success',
          requestId: reqId,
          shopDomain: integration.platformStoreUrl,
          orderId: orderGid,
          tag,
        }),
      );
    } catch (error: unknown) {
      this.logger.error(
        buildBackendLog(ShopifyApiService.name, {
          action: 'shopify-order-tag-add',
          outcome: 'failure',
          shopDomain: integration.platformStoreUrl,
          orderId: orderGid,
          tag,
          ...normalizeError(error),
        }),
      );
      throw error;
    }
  }

  async removeOrderTags(
    integration: CommerceOutcomeConnection,
    orderId: string,
    tags: readonly string[],
  ): Promise<void> {
    if (tags.length === 0) return;
    const response = await this.executeGraphql<TagsRemoveResponse>(
      integration,
      TAGS_REMOVE_MUTATION,
      { id: toOrderGid(orderId), tags },
      10_000,
    );
    this.logGraphQLResponseIssues({
      operation: 'tagsRemove',
      graphQLErrors: response.data.errors,
      userErrors: response.data.data?.tagsRemove?.userErrors,
      headers: response.headers,
    });
    throwIfGraphQLErrors(
      response.data.errors,
      'Shopify order tag removal failed',
    );
    throwIfUserErrors(
      response.data.data?.tagsRemove?.userErrors,
      'Shopify order tag removal rejected',
    );
    if (!response.data.data?.tagsRemove?.node?.id)
      throw new Error('Shopify tag removal outcome unknown');
  }

  async createTestCodOrder(
    integration: CommerceOutcomeConnection,
    input: { phone: string; amount: string; currencyCode: string },
  ): Promise<TestCodOrder> {
    const response = await this.executeGraphql<CreateTestCodOrderResponse>(
      integration,
      CREATE_TEST_COD_ORDER_MUTATION,
      {
        order: {
          test: true,
          financialStatus: 'PENDING',
          email: 'akeed-cod-test@example.com',
          phone: input.phone,
          tags: ['Akeed: Test'],
          lineItems: [
            {
              title: 'Akeed COD Test',
              quantity: 1,
              priceSet: {
                shopMoney: {
                  amount: input.amount,
                  currencyCode: input.currencyCode,
                },
              },
            },
          ],
          transactions: [
            {
              gateway: 'Cash on Delivery (COD)',
              kind: 'SALE',
              status: 'PENDING',
              test: true,
              amountSet: {
                shopMoney: {
                  amount: input.amount,
                  currencyCode: input.currencyCode,
                },
              },
            },
          ],
        },
      },
    );

    throwIfGraphQLErrors(response.data.errors, 'Shopify order creation errors');
    throwIfUserErrors(
      response.data.data?.orderCreate?.userErrors,
      'Shopify order creation validation failed',
    );

    const order = response.data.data?.orderCreate?.order;
    if (!order) throw new Error('Shopify did not return the created order');
    return order;
  }

  async cancelOrder(
    integration: CommerceOutcomeConnection,
    externalOrderId: string,
    reason: string,
    options: CommerceCancellationOptions = {
      restock: true,
      notifyCustomer: false,
    },
  ): Promise<{ jobId?: string }> {
    const orderGid = toOrderGid(externalOrderId);

    const response = await this.executeGraphql<OrderCancelResponse>(
      integration,
      ORDER_CANCEL_MUTATION,
      {
        orderId: orderGid,
        reason,
        notifyCustomer: options.notifyCustomer,
        refund: false,
        restock: options.restock,
        staffNote:
          options.staffNote ??
          'Canceled by Akeed after no reply to COD verification.',
      },
    );

    throwIfGraphQLErrors(
      response.data.errors,
      'Shopify order cancellation errors',
    );
    throwIfUserErrors(
      response.data.data?.orderCancel?.orderCancelUserErrors,
      'Shopify order cancellation validation failed',
    );

    const jobId = response.data.data?.orderCancel?.job?.id;
    this.logger.log(
      buildBackendLog(ShopifyApiService.name, {
        action: 'shopify-order-cancel',
        outcome: 'success',
        requestId: getRequestId(response.headers),
        shopDomain: integration.platformStoreUrl,
        orderId: orderGid,
        jobId,
      }),
    );

    return { jobId: jobId ?? undefined };
  }

  /** The order's cancel, payment and fulfillment state. Null when Shopify has no such order. */
  async getOrderCancellationState(
    integration: CommerceOutcomeConnection,
    externalOrderId: string,
  ): Promise<ShopifyOrderCancellationState | null> {
    const response = await this.executeGraphql<OrderCancellationStateResponse>(
      integration,
      ORDER_CANCELLATION_STATE_QUERY,
      { id: toOrderGid(externalOrderId) },
    );
    throwIfGraphQLErrors(response.data.errors, 'Shopify order read errors');
    return response.data.data?.order ?? null;
  }

  /** The order's current details. Null when Shopify has no such order. */
  async getCurrentOrder(
    integration: CommerceOutcomeConnection,
    externalOrderId: string,
  ): Promise<ShopifyCurrentOrder | null> {
    const response = await this.executeGraphql<CurrentOrderResponse>(
      integration,
      CURRENT_ORDER_QUERY,
      { id: toOrderGid(externalOrderId) },
    );
    throwIfGraphQLErrors(response.data.errors, 'Shopify order read errors');
    return response.data.data?.order ?? null;
  }

  /** Whether an asynchronous job, such as an order cancellation, finished. */
  async isJobDone(
    integration: CommerceOutcomeConnection,
    jobId: string,
  ): Promise<boolean> {
    const response = await this.executeGraphql<JobStatusResponse>(
      integration,
      JOB_STATUS_QUERY,
      { id: jobId },
    );
    throwIfGraphQLErrors(response.data.errors, 'Shopify job read errors');
    return response.data.data?.job?.done === true;
  }

  async getShopName(integration: CommerceOutcomeConnection): Promise<string> {
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
    integration: CommerceOutcomeConnection,
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
        // Shopify may defer a replacement that matches the current
        // subscription to the next cycle; a renewal must start now.
        replacementBehavior: payload.replaceImmediately
          ? 'APPLY_IMMEDIATELY'
          : 'STANDARD',
        // Shopify starts the trial when the merchant approves the charge;
        // the first charge comes when it ends. Sent only when there is one.
        ...(payload.trialDays && payload.trialDays > 0
          ? { trialDays: payload.trialDays }
          : {}),
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
    integration: CommerceOutcomeConnection,
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
      ...(typeof node.trialDays === 'number'
        ? { trialDays: node.trialDays }
        : {}),
    };
  }

  /** The subscriptions Shopify currently bills this installation for. */
  async listActiveAppSubscriptions(
    integration: CommerceOutcomeConnection,
  ): Promise<AppSubscriptionStatusResult[]> {
    const response = await this.executeGraphql<ActiveAppSubscriptionsResponse>(
      integration,
      GET_ACTIVE_APP_SUBSCRIPTIONS_QUERY,
      {},
    );

    throwIfGraphQLErrors(
      response.data.errors,
      'Shopify active subscriptions errors',
    );

    const installation = response.data.data?.currentAppInstallation;
    if (!installation) {
      throw new Error('Shopify did not return the app installation');
    }

    return (installation.activeSubscriptions ?? []).flatMap((node) =>
      node.id && node.status ? [{ id: node.id, status: node.status }] : [],
    );
  }

  async cancelAppSubscription(
    integration: CommerceOutcomeConnection,
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
      buildBackendLog(ShopifyApiService.name, {
        action: 'shopify-app-subscription-cancel',
        outcome: 'success',
        requestId: getRequestId(response.headers),
        shopDomain: integration.platformStoreUrl,
        subscriptionId: gid,
        status: cancelledStatus ?? 'unknown',
        prorate,
      }),
    );
  }

  async reportUsageCharge(
    integration: CommerceOutcomeConnection,
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
      buildBackendLog(ShopifyApiService.name, {
        action: 'shopify-usage-record-create',
        outcome: 'success',
        requestId: getRequestId(response.headers),
        shopDomain: integration.platformStoreUrl,
        subscriptionId: gid,
        amount,
        currencyCode,
      }),
    );
  }

  private async executeGraphql<T>(
    integration: CommerceOutcomeConnection,
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<AxiosResponse<T>> {
    const accessToken = await this.getAccessTokenOrThrow(integration);
    const send = (token: string) => {
      const request = this._httpService.post<T>(
        this.getGraphqlUrl(integration.platformStoreUrl),
        {
          query,
          variables,
        },
        {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        },
      );
      return firstValueFrom(
        timeoutMs ? request.pipe(timeout(timeoutMs)) : request,
      );
    };

    try {
      return await send(accessToken.token);
    } catch (error) {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      if (!this.credentials) throw error;
      // A 401 is answered before Shopify runs anything, so one retry with a
      // renewed token cannot repeat a write.
      if (status === 401 && accessToken.kind === 'expiring') {
        const renewed = await this.credentials.renew(
          integration,
          accessToken.generation,
          true,
        );
        return send(renewed.token);
      }
      if (
        isAxiosError(error) &&
        isLegacyTokenRejection(status, error.response?.data)
      ) {
        await this.credentials.markReauthRequired(
          integration,
          'legacy_token_rejected',
        );
        throw new ShopifyReauthRequiredError(
          integration.platformStoreUrl,
          'legacy_token_rejected',
        );
      }
      throw error;
    }
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
        buildBackendLog(ShopifyApiService.name, {
          action: `${params.operation}-graphql-response`,
          outcome: 'failure',
          requestId,
          graphQLErrors: params.graphQLErrors,
        }),
      );
    }

    if (params.userErrors && params.userErrors.length > 0) {
      this.logger.error(
        buildBackendLog(ShopifyApiService.name, {
          action: `${params.operation}-graphql-response`,
          outcome: 'failure',
          requestId,
          userErrors: params.userErrors,
        }),
      );
    }
  }

  private async getAccessTokenOrThrow(
    integration: CommerceOutcomeConnection,
  ): Promise<ShopifyAccessToken> {
    if (this.credentials) return this.credentials.getAccessToken(integration);
    if (integration.accessToken) {
      const encryptionKey = this.configService.get<string>(
        'SHOPIFY_TOKEN_ENCRYPTION_KEY',
      );

      if (!encryptionKey) {
        throw new Error('Missing SHOPIFY_TOKEN_ENCRYPTION_KEY');
      }

      try {
        return {
          token: decryptToken(integration.accessToken, encryptionKey),
          kind: 'legacy',
          generation: 0,
        };
      } catch {
        throw new Error(
          `Unable to decrypt the stored Shopify token for ${integration.platformStoreUrl}. Reconnect the store using the current SHOPIFY_TOKEN_ENCRYPTION_KEY.`,
        );
      }
    }

    this.logger.error(
      buildBackendLog(ShopifyApiService.name, {
        action: 'shopify-access-token-resolve',
        outcome: 'failure',
        shopDomain: integration.platformStoreUrl,
        errorCode: 'missing_access_token',
      }),
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
