import { of, throwError } from 'rxjs';
import { ShopifyApiService } from './shopify-api.service';
import {
  CREATE_TEST_COD_ORDER_MUTATION,
  ORDER_CANCEL_MUTATION,
} from './shopify-api.service.helpers';
import { encryptToken } from '../../../../shared/utils/token-encryption.util';
import type { integrations } from '../../../database/schema';

describe('ShopifyApiService cancellation contract', () => {
  const encryptionKey = 'a'.repeat(64);
  const integration = {
    platformStoreUrl: 'synthetic.myshopify.com',
    accessToken: encryptToken('synthetic-shop-token', encryptionKey),
  } as typeof integrations.$inferSelect;

  function setup(response: unknown, version?: string) {
    const post = jest.fn().mockReturnValue(of({ data: response, headers: {} }));
    const config = {
      get: (key: string) =>
        key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY'
          ? encryptionKey
          : key === 'SHOPIFY_API_VERSION'
            ? version
            : undefined,
    };
    return {
      post,
      service: new ShopifyApiService({ post } as never, config as never),
    };
  }

  it.each(['12345', 'gid://shopify/Order/12345'])(
    'cancels %s with the existing GraphQL variables and extracts the job reference',
    async (orderId) => {
      const { service, post } = setup({
        data: {
          orderCancel: {
            job: { id: 'gid://shopify/Job/42' },
            orderCancelUserErrors: [],
          },
        },
      });
      await expect(
        service.cancelOrder(integration, orderId, 'OTHER'),
      ).resolves.toEqual({ jobId: 'gid://shopify/Job/42' });
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(
        'https://synthetic.myshopify.com/admin/api/2026-01/graphql.json',
        {
          query: ORDER_CANCEL_MUTATION,
          variables: {
            orderId: 'gid://shopify/Order/12345',
            reason: 'OTHER',
            notifyCustomer: false,
            refund: false,
            restock: true,
            staffNote: 'Canceled by Akeed after no reply to COD verification.',
          },
        },
        {
          headers: {
            'X-Shopify-Access-Token': 'synthetic-shop-token',
            'Content-Type': 'application/json',
          },
        },
      );
    },
  );

  it('honors configured API version without polling when job is absent', async () => {
    const { service, post } = setup(
      { data: { orderCancel: { job: null, orderCancelUserErrors: [] } } },
      '2026-04',
    );
    await expect(
      service.cancelOrder(integration, '12345', 'CUSTOMER'),
    ).resolves.toEqual({ jobId: undefined });
    expect(post).toHaveBeenCalledWith(
      'https://synthetic.myshopify.com/admin/api/2026-04/graphql.json',
      expect.any(Object),
      expect.any(Object),
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'GraphQL',
      { errors: [{ message: 'synthetic permission error' }] },
      'Shopify order cancellation errors',
    ],
    [
      'mutation user',
      {
        data: {
          orderCancel: {
            orderCancelUserErrors: [
              { field: ['orderId'], message: 'cannot cancel' },
            ],
          },
        },
      },
      'Shopify order cancellation validation failed',
    ],
  ])('rejects %s errors', async (_kind, response, expected) => {
    await expect(
      setup(response).service.cancelOrder(integration, '12345', 'OTHER'),
    ).rejects.toThrow(expected);
  });

  it('propagates HTTP transport failure', async () => {
    const { service, post } = setup({});
    post.mockReturnValue(
      throwError(() => new Error('synthetic transport failure')),
    );
    await expect(
      service.cancelOrder(integration, '12345', 'OTHER'),
    ).rejects.toThrow('synthetic transport failure');
  });

  it('creates a tagged pending COD test order without exposing the token', async () => {
    const created = {
      id: 'gid://shopify/Order/42',
      name: '#1042',
      test: true,
      displayFinancialStatus: 'PENDING',
    };
    const { service, post } = setup({
      data: { orderCreate: { order: created, userErrors: [] } },
    });

    await expect(
      service.createTestCodOrder(integration, {
        phone: '+201001234567',
        amount: '49.95',
        currencyCode: 'USD',
      }),
    ).resolves.toEqual(created);

    expect(post).toHaveBeenCalledWith(
      'https://synthetic.myshopify.com/admin/api/2026-01/graphql.json',
      {
        query: CREATE_TEST_COD_ORDER_MUTATION,
        variables: {
          order: {
            test: true,
            financialStatus: 'PENDING',
            email: 'akeed-cod-test@example.com',
            phone: '+201001234567',
            tags: ['akeed-test', 'akeed-cod-test'],
            lineItems: [
              {
                title: 'Akeed COD Test',
                quantity: 1,
                priceSet: {
                  shopMoney: { amount: '49.95', currencyCode: 'USD' },
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
                  shopMoney: { amount: '49.95', currencyCode: 'USD' },
                },
              },
            ],
          },
        },
      },
      {
        headers: {
          'X-Shopify-Access-Token': 'synthetic-shop-token',
          'Content-Type': 'application/json',
        },
      },
    );
  });
});
