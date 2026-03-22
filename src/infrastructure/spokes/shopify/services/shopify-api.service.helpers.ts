import type { AxiosResponse } from 'axios';

export interface GraphQLErrorItem {
  message: string;
  locations?: unknown;
  path?: string[];
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

export function throwIfGraphQLErrors(
  errors: GraphQLErrorItem[] | undefined,
  context: string,
): void {
  if (!errors || errors.length === 0) {
    return;
  }

  throw new Error(
    `${context}: ${errors.map((error) => error.message).join('; ')}`,
  );
}

export function throwIfUserErrors(
  errors: GraphQLUserError[] | undefined,
  context: string,
): void {
  if (!errors || errors.length === 0) {
    return;
  }

  throw new Error(
    `${context}: ${errors.map((error) => error.message).join('; ')}`,
  );
}

export function toOrderGid(orderId: string): string {
  return orderId.startsWith('gid://')
    ? orderId
    : `gid://shopify/Order/${orderId}`;
}

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
