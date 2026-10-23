import {
  classifyShopifyCancellationState,
  ShopifyOutcomeAdapter,
} from './shopify-outcome.adapter';
import type { ShopifyOrderCancellationState } from './shopify-api.service.helpers';

const OPEN_COD: ShopifyOrderCancellationState = {
  cancelledAt: null,
  closed: false,
  displayFinancialStatus: 'PENDING',
  displayFulfillmentStatus: 'UNFULFILLED',
};

describe('classifyShopifyCancellationState', () => {
  it('allows only an open, unpaid, unfulfilled order', () => {
    expect(classifyShopifyCancellationState(OPEN_COD)).toEqual({
      state: 'cancellable',
      providerStatus: 'PENDING/UNFULFILLED',
    });
  });

  it.each([
    [{ cancelledAt: '2026-10-01T00:00:00Z' }, 'already_canceled', undefined],
    [{ displayFinancialStatus: 'PAID' }, 'not_cancellable', 'paid'],
    [{ displayFinancialStatus: 'PARTIALLY_PAID' }, 'not_cancellable', 'paid'],
    [{ displayFulfillmentStatus: 'FULFILLED' }, 'not_cancellable', 'fulfilled'],
    [
      { displayFulfillmentStatus: 'PARTIALLY_FULFILLED' },
      'not_cancellable',
      'fulfilled',
    ],
    [
      { displayFulfillmentStatus: 'IN_PROGRESS' },
      'not_cancellable',
      'fulfillment_in_progress',
    ],
    [
      { displayFulfillmentStatus: 'ON_HOLD' },
      'not_cancellable',
      'fulfillment_in_progress',
    ],
    [{ closed: true }, 'not_cancellable', 'status_not_writable'],
  ] as const)('reads %j as %s', (change, state, reason) => {
    const result = classifyShopifyCancellationState({ ...OPEN_COD, ...change });
    expect(result.state).toBe(state);
    if (reason) expect(result).toMatchObject({ reason });
  });

  it('reports a missing order as not cancellable', () => {
    expect(classifyShopifyCancellationState(null)).toEqual({
      state: 'not_cancellable',
      reason: 'order_not_found',
    });
  });
});

describe('ShopifyOutcomeAdapter automatic cancellation', () => {
  const connection = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'shop.myshopify.com',
    accessToken: 'encrypted',
    isActive: true,
    metadata: {},
  };
  const request = {
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: '1001',
    correlationId: 'ver-1',
    action: 'automatic_no_reply_cancellation' as const,
    cancellation: { restock: false, notifyCustomer: true, staffNote: 'note' },
    connection,
  };

  function setup() {
    const api = {
      cancelOrder: jest
        .fn()
        .mockResolvedValue({ jobId: 'gid://shopify/Job/1' }),
      getOrderCancellationState: jest.fn().mockResolvedValue(OPEN_COD),
      isJobDone: jest.fn().mockResolvedValue(true),
      addOrderTag: jest.fn(),
    };
    return { api, adapter: new ShopifyOutcomeAdapter(api as never) };
  }

  it('passes the merchant restock and notify choices to orderCancel', async () => {
    const { api, adapter } = setup();
    await expect(adapter.execute(request)).resolves.toEqual({
      status: 'pending_provider_operation',
      providerOperationId: 'gid://shopify/Job/1',
    });
    expect(api.cancelOrder).toHaveBeenCalledWith(
      connection,
      '1001',
      'CUSTOMER',
      { restock: false, notifyCustomer: true, staffNote: 'note' },
    );
  });

  it('keeps the merchant cancel on the fixed defaults', async () => {
    const { api, adapter } = setup();
    await adapter.execute({
      ...request,
      action: 'merchant_no_reply_cancellation',
    });
    expect(api.cancelOrder).toHaveBeenCalledWith(
      connection,
      '1001',
      'CUSTOMER',
      undefined,
    );
  });

  it('reads the order and the job', async () => {
    const { api, adapter } = setup();
    await expect(
      adapter.inspectForCancellation(request),
    ).resolves.toMatchObject({ state: 'cancellable' });
    await expect(
      adapter.resolveOperation(request, 'gid://shopify/Job/1'),
    ).resolves.toEqual({ state: 'done' });
    api.isJobDone.mockResolvedValue(false);
    await expect(
      adapter.resolveOperation(request, 'gid://shopify/Job/1'),
    ).resolves.toEqual({ state: 'running' });
  });

  it('fails closed without a token', async () => {
    const { adapter } = setup();
    await expect(
      adapter.inspectForCancellation({
        ...request,
        connection: { ...connection, accessToken: null },
      }),
    ).resolves.toEqual({
      state: 'permanent_failure',
      errorCode: 'connection_incomplete',
    });
  });
});
