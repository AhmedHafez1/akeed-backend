import { of, throwError, type Observable } from 'rxjs';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ShopifyApiService } from './shopify-api.service';
import { ShopifyOutcomeAdapter } from './shopify-outcome.adapter';
import { CommerceOutcomeModule } from '../../../../modules/commerce-outcomes/commerce-outcome.module';
import { CommerceOutcomeRegistryService } from '../../../../modules/commerce-outcomes/commerce-outcome-registry.service';
import { DRIZZLE } from '../../../database/database.provider';
import { OrdersRepository } from '../../../database/repositories/orders.repository';
import { encryptToken } from '../../../../shared/utils/token-encryption.util';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAction,
} from '../../../../shared/commerce/commerce-outcome';
import { defineCommerceOutcomeAdapterContract } from '../../../../../test/contracts/commerce-outcome-adapter.contract';

const key = 'a'.repeat(64);
function setup() {
  const post = jest
    .fn<
      Observable<unknown>,
      [string, { query: string; variables: unknown }, unknown]
    >()
    .mockReturnValue(
      of({
        data: {
          data: {
            orderCancel: {
              job: { id: 'gid://shopify/Job/42' },
              orderCancelUserErrors: [],
            },
            tagsAdd: {
              node: { id: 'gid://shopify/Order/12345' },
              userErrors: [],
            },
          },
        },
        headers: {},
      }),
    );
  const api = new ShopifyApiService(
    { post } as never,
    {
      get: (name: string) =>
        name === 'SHOPIFY_TOKEN_ENCRYPTION_KEY' ? key : undefined,
    } as never,
  );
  const order = {
    id: 'order-1',
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: '12345',
    isTest: false,
    integration: {
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'shopify',
      isActive: true,
      platformStoreUrl: 'synthetic.myshopify.com',
      accessToken: encryptToken('synthetic-token', key),
      metadata: {},
    },
  };
  const findForOutcomeDispatch = jest.fn().mockResolvedValue(order);
  const registry = new CommerceOutcomeRegistryService(
    { findForOutcomeDispatch } as never,
    [new ShopifyOutcomeAdapter(api)],
  );
  const dispatch = (action: CommerceOutcomeAction) =>
    registry.dispatch({
      orgId: 'org-1',
      integrationId: 'int-1',
      externalOrderId: order.externalOrderId,
      correlationId: 'ver-1',
      action,
    });
  return { order, post, api, registry, dispatch, findForOutcomeDispatch };
}

defineCommerceOutcomeAdapterContract({
  name: 'Shopify',
  platformType: 'shopify',
  capabilities: COMMERCE_OUTCOME_ACTIONS,
  expectedStatus: {
    customer_confirmation: 'applied',
    customer_cancellation: 'applied',
    merchant_no_reply_cancellation: 'pending_provider_operation',
    merchant_cancellation_tagging: 'applied',
    automatic_no_reply_tagging: 'applied',
  },
  createFixture: (action) => {
    const { api, order } = setup();
    return {
      adapter: new ShopifyOutcomeAdapter(api),
      request: {
        orgId: order.orgId,
        integrationId: order.integrationId,
        externalOrderId: order.externalOrderId,
        correlationId: 'adapter-contract-verification',
        action,
        connection: order.integration,
      },
    };
  },
});

describe('Shopify outcome dispatch through the real GraphQL service', () => {
  it.each([
    ['customer_confirmation', 'Akeed: Verified'],
    ['customer_cancellation', 'Akeed: Canceled'],
    ['merchant_cancellation_tagging', 'Akeed: Canceled'],
    ['automatic_no_reply_tagging', 'Akeed: No Reply'],
  ] as const)('%s only adds its existing tag', async (action, tag) => {
    const { post, dispatch } = setup();
    await expect(dispatch(action)).resolves.toMatchObject({
      status: 'applied',
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({
      query: expect.stringContaining('tagsAdd') as unknown,
      variables: { id: 'gid://shopify/Order/12345', tags: [tag] },
    });
  });

  it('returns the asynchronous reference with unchanged merchant cancellation variables', async () => {
    const { post, dispatch } = setup();
    await expect(
      dispatch('merchant_no_reply_cancellation'),
    ).resolves.toMatchObject({
      status: 'pending_provider_operation',
      providerOperationId: 'gid://shopify/Job/42',
    });
    expect(post.mock.calls[0][0]).toBe(
      'https://synthetic.myshopify.com/admin/api/2026-01/graphql.json',
    );
    expect(post.mock.calls[0][1]).toEqual({
      query: expect.stringContaining('orderCancel') as unknown,
      variables: {
        orderId: 'gid://shopify/Order/12345',
        reason: 'CUSTOMER',
        notifyCustomer: false,
        refund: false,
        restock: true,
        staffNote: 'Canceled by Akeed after no reply to COD verification.',
      },
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('preserves acceptance without asserting remote completion when no job is returned', async () => {
    const { post, dispatch } = setup();
    post.mockReturnValue(
      of({
        data: {
          data: { orderCancel: { job: null, orderCancelUserErrors: [] } },
        },
        headers: {},
      }),
    );
    await expect(
      dispatch('merchant_no_reply_cancellation'),
    ).resolves.toMatchObject({ status: 'accepted_without_reference' });
  });

  it.each(COMMERCE_OUTCOME_ACTIONS)(
    'suppresses %s for synthetic prefix and persisted test flag',
    async (action) => {
      for (const marker of ['prefix', 'flag']) {
        const { order, dispatch, post } = setup();
        if (marker === 'prefix') order.externalOrderId = 'akeed-test-123';
        else order.isTest = true;
        await expect(dispatch(action)).resolves.toMatchObject({
          status: 'applied',
        });
        expect(post).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    'inactive',
    'foreign_owner',
    'mismatched_id',
    'missing',
    'unsupported',
  ])('blocks %s connections before HTTP', async (kind) => {
    const { order, dispatch, post, findForOutcomeDispatch } = setup();
    if (kind === 'inactive') order.integration.isActive = false;
    if (kind === 'foreign_owner') order.integration.orgId = 'org-2';
    if (kind === 'mismatched_id') order.integration.id = 'int-2';
    if (kind === 'missing')
      findForOutcomeDispatch.mockResolvedValue({ ...order, integration: null });
    if (kind === 'unsupported') order.integration.platformType = 'standalone';
    await expect(
      dispatch('merchant_no_reply_cancellation'),
    ).resolves.toMatchObject({
      status: kind === 'unsupported' ? 'unsupported' : 'permanent_failure',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['customer_confirmation', 'merchant_no_reply_cancellation'] as const)(
    'reports %s transport failure without leaking the provider exception',
    async (action) => {
      const { post, dispatch } = setup();
      post.mockReturnValue(
        throwError(() => new Error('synthetic transport failure')),
      );
      const result = await dispatch(action);
      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'adapter_execution_failed',
      });
      expect(JSON.stringify(result)).not.toContain(
        'synthetic transport failure',
      );
    },
  );

  it('reports GraphQL tag rejection without claiming synchronization applied', async () => {
    const { post, dispatch } = setup();
    post.mockReturnValue(
      of({
        data: {
          data: { tagsAdd: { userErrors: [{ message: 'Rejected tag' }] } },
        },
        headers: {},
      }),
    );
    await expect(dispatch('customer_confirmation')).resolves.toMatchObject({
      status: 'retryable_failure',
    });
  });

  it('wires the production module to the Shopify adapter without live infrastructure', async () => {
    const { api, order, post } = setup();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        CommerceOutcomeModule,
      ],
    })
      .overrideProvider(DRIZZLE)
      .useValue({})
      .overrideProvider(OrdersRepository)
      .useValue({ findForOutcomeDispatch: jest.fn().mockResolvedValue(order) })
      .overrideProvider(ShopifyApiService)
      .useValue(api)
      .compile();
    try {
      await expect(
        module.get(CommerceOutcomeRegistryService).dispatch({
          orgId: order.orgId,
          integrationId: order.integrationId,
          externalOrderId: order.externalOrderId,
          action: 'customer_confirmation',
          correlationId: 'ver-1',
        }),
      ).resolves.toMatchObject({ status: 'applied' });
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });
});
