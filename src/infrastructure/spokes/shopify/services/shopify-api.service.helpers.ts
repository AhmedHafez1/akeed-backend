import type { AxiosResponse } from 'axios';

export interface GraphQLErrorItem {
  message: string;
  locations?: unknown;
  path?: string[];
  extensions?: { code?: unknown };
}

export interface GraphQLUserError {
  field?: string[];
  message: string;
}

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: GraphQLErrorItem[];
}

export type TagsAddResponse = GraphQLResponse<{
  tagsAdd?: {
    node?: { id: string };
    userErrors?: GraphQLUserError[];
  };
}>;

export type TagsRemoveResponse = GraphQLResponse<{
  tagsRemove?: { node?: { id: string }; userErrors?: GraphQLUserError[] };
}>;

export const TAGS_REMOVE_MUTATION = `
  mutation tagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

export type ShopNameResponse = GraphQLResponse<{
  shop?: {
    name?: string;
  };
}>;

export type AppSubscriptionCreateResponse = GraphQLResponse<{
  appSubscriptionCreate?: {
    confirmationUrl?: string;
    userErrors?: GraphQLUserError[];
  };
}>;

export type AppSubscriptionStatusResponse = GraphQLResponse<{
  node?: {
    id?: string;
    status?: string;
  } | null;
}>;

export type AppSubscriptionCancelResponse = GraphQLResponse<{
  appSubscriptionCancel?: {
    appSubscription?: {
      id: string;
      status: string;
    };
    userErrors?: GraphQLUserError[];
  };
}>;

export interface AppSubscriptionLineItemNode {
  id: string;
  plan: {
    pricingDetails: {
      __typename: string;
    };
  };
}

export type AppSubscriptionLineItemsResponse = GraphQLResponse<{
  node?: {
    id?: string;
    lineItems?: AppSubscriptionLineItemNode[];
  } | null;
}>;

export type AppUsageRecordCreateResponse = GraphQLResponse<{
  appUsageRecordCreate?: {
    appUsageRecord?: { id: string };
    userErrors?: GraphQLUserError[];
  };
}>;

interface AppSubscriptionRecurringLineItem {
  plan: {
    appRecurringPricingDetails: {
      price: {
        amount: number;
        currencyCode: string;
      };
      interval: 'EVERY_30_DAYS';
    };
  };
}

interface AppSubscriptionUsageLineItem {
  plan: {
    appUsagePricingDetails: {
      terms: string;
      cappedAmount: {
        amount: number;
        currencyCode: string;
      };
    };
  };
}

export type AppSubscriptionLineItem =
  | AppSubscriptionRecurringLineItem
  | AppSubscriptionUsageLineItem;

export const TAGS_ADD_MUTATION = `
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

export const GET_SHOP_NAME_QUERY = `
  query GetShopName {
    shop {
      name
    }
  }
`;

export const CREATE_APP_SUBSCRIPTION_MUTATION = `
  mutation CreateAppSubscription(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $test: Boolean
    $replacementBehavior: AppSubscriptionReplacementBehavior
  ) {
    appSubscriptionCreate(
      name: $name
      lineItems: $lineItems
      returnUrl: $returnUrl
      test: $test
      replacementBehavior: $replacementBehavior
    ) {
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

export const GET_APP_SUBSCRIPTION_STATUS_QUERY = `
  query GetAppSubscriptionStatus($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        status
      }
    }
  }
`;

export const CANCEL_APP_SUBSCRIPTION_MUTATION = `
  mutation AppSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const GET_SUBSCRIPTION_LINE_ITEMS_QUERY = `
  query GetSubscriptionLineItems($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
            }
          }
        }
      }
    }
  }
`;

export const CREATE_USAGE_RECORD_MUTATION = `
  mutation AppUsageRecordCreate(
    $subscriptionLineItemId: ID!
    $price: MoneyInput!
    $description: String!
  ) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId
      price: $price
      description: $description
    ) {
      appUsageRecord {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export function validateUsageBillingPayload(payload: {
  cappedAmount?: number;
  usageTerms?: string;
}): void {
  const hasCappedAmount = payload.cappedAmount !== undefined;
  const hasUsageTerms = Boolean(payload.usageTerms);

  if (hasCappedAmount !== hasUsageTerms) {
    throw new Error(
      'Shopify usage billing configuration requires both cappedAmount and usageTerms',
    );
  }
}

export function buildSubscriptionLineItems(payload: {
  amount: number;
  currencyCode: string;
  cappedAmount?: number;
  usageTerms?: string;
}): AppSubscriptionLineItem[] {
  const recurringLineItem: AppSubscriptionRecurringLineItem = {
    plan: {
      appRecurringPricingDetails: {
        price: {
          amount: payload.amount,
          currencyCode: payload.currencyCode,
        },
        interval: 'EVERY_30_DAYS',
      },
    },
  };

  if (payload.cappedAmount === undefined || !payload.usageTerms) {
    return [recurringLineItem];
  }

  const usageLineItem: AppSubscriptionUsageLineItem = {
    plan: {
      appUsagePricingDetails: {
        terms: payload.usageTerms,
        cappedAmount: {
          amount: payload.cappedAmount,
          currencyCode: payload.currencyCode,
        },
      },
    },
  };

  return [recurringLineItem, usageLineItem];
}

/**
 * A GraphQL answer Shopify returned with HTTP 200 but refused: top-level
 * `errors` (throttling, access, query problems) or a mutation's `userErrors`
 * (the input itself was rejected). Callers that classify failures read `kind`
 * and `codes`; the message stays what it always was.
 */
export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly kind: 'graphql' | 'user',
    readonly codes: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ShopifyGraphqlError';
  }
}

export function throwIfGraphQLErrors(
  errors: GraphQLErrorItem[] | undefined,
  context: string,
): void {
  if (!errors || errors.length === 0) {
    return;
  }

  throw new ShopifyGraphqlError(
    `${context}: ${errors.map((error) => error.message).join('; ')}`,
    'graphql',
    errors.flatMap((error) =>
      typeof error.extensions?.code === 'string' ? [error.extensions.code] : [],
    ),
  );
}

export function throwIfUserErrors(
  errors: GraphQLUserError[] | undefined,
  context: string,
): void {
  if (!errors || errors.length === 0) {
    return;
  }

  throw new ShopifyGraphqlError(
    `${context}: ${errors.map((error) => error.message).join('; ')}`,
    'user',
  );
}

export function toOrderGid(orderId: string): string {
  return orderId.startsWith('gid://')
    ? orderId
    : `gid://shopify/Order/${orderId}`;
}

export type OrderCancelResponse = GraphQLResponse<{
  orderCancel?: {
    job?: { id: string };
    orderCancelUserErrors?: GraphQLUserError[];
  };
}>;

/** What an automatic cancellation reads about the order first. */
export interface ShopifyOrderCancellationState {
  cancelledAt: string | null;
  closed: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
}

export type OrderCancellationStateResponse = GraphQLResponse<{
  order?: ShopifyOrderCancellationState | null;
}>;

export const ORDER_CANCELLATION_STATE_QUERY = `
  query orderCancellationState($id: ID!) {
    order(id: $id) {
      cancelledAt
      closed
      displayFinancialStatus
      displayFulfillmentStatus
    }
  }
`;

interface CurrentOrderMoney {
  shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
}

interface CurrentOrderAddress {
  phone?: string | null;
  countryCodeV2?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
}

/** An order as `CURRENT_ORDER_QUERY` reads it. */
export interface ShopifyCurrentOrder {
  legacyResourceId?: string | null;
  phone?: string | null;
  paymentGatewayNames?: string[] | null;
  currentTotalPriceSet?: CurrentOrderMoney | null;
  customer?: {
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    defaultAddress?: CurrentOrderAddress | null;
  } | null;
  billingAddress?: CurrentOrderAddress | null;
  shippingAddress?: CurrentOrderAddress | null;
  lineItems?: {
    nodes?: Array<{
      title?: string | null;
      variantTitle?: string | null;
      currentQuantity?: number | null;
      originalUnitPriceSet?: CurrentOrderMoney | null;
    } | null> | null;
  } | null;
}

export type CurrentOrderResponse = GraphQLResponse<{
  order?: ShopifyCurrentOrder | null;
}>;

/**
 * The details a confirmation shows, as the order is now: the current total
 * and quantities after any order edit, the shipping address and the
 * customer's phone candidates in the order the webhook normalizer tries
 * them. Read-only; needs only `read_orders` and `read_customers`.
 */
export const CURRENT_ORDER_QUERY = `
  query currentOrder($id: ID!) {
    order(id: $id) {
      legacyResourceId
      phone
      paymentGatewayNames
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      customer {
        firstName
        lastName
        phone
        defaultAddress {
          phone
          countryCodeV2
        }
      }
      billingAddress {
        phone
        countryCodeV2
      }
      shippingAddress {
        phone
        countryCodeV2
        address1
        address2
        city
        province
      }
      lineItems(first: 100) {
        nodes {
          title
          variantTitle
          currentQuantity
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
`;

export type JobStatusResponse = GraphQLResponse<{
  job?: { id: string; done: boolean } | null;
}>;

export const JOB_STATUS_QUERY = `
  query jobStatus($id: ID!) {
    job(id: $id) {
      id
      done
    }
  }
`;

export interface TestCodOrder {
  id: string;
  name: string;
  test: boolean;
  displayFinancialStatus: string;
}

export type CreateTestCodOrderResponse = GraphQLResponse<{
  orderCreate?: {
    order?: TestCodOrder;
    userErrors?: GraphQLUserError[];
  };
}>;

export const CREATE_TEST_COD_ORDER_MUTATION = `
  mutation CreateTestCodOrder($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) {
      order {
        id
        name
        test
        displayFinancialStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_CANCEL_MUTATION = `
  mutation orderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $notifyCustomer: Boolean
    $refund: Boolean!
    $restock: Boolean!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      notifyCustomer: $notifyCustomer
      refund: $refund
      restock: $restock
      staffNote: $staffNote
    ) {
      job {
        id
      }
      orderCancelUserErrors {
        field
        message
      }
    }
  }
`;

export function toAppSubscriptionGid(chargeId: string): string {
  return chargeId.startsWith('gid://')
    ? chargeId
    : `gid://shopify/AppSubscription/${chargeId}`;
}

export function getRequestId(
  headers?: AxiosResponse['headers'],
): string | undefined {
  return (headers?.['x-request-id'] ?? headers?.['X-Request-Id']) as
    | string
    | undefined;
}
