import { WebhookQueueProducer } from './webhook-queue.producer';
import { WebhookJobType } from './webhook-queue.constants';
import { shopifyOrderFixture } from './normalizers/fixtures/shopify-order.fixture';

function setup() {
  const events = {
    insertIfNew: jest.fn().mockResolvedValue({
      id: 'event-1',
      receivedAt: '2026-05-15T00:00:00.000Z',
    }),
    findBySourceAndIdempotency: jest.fn(),
  };
  const integrations = {
    findByPlatformDomain: jest
      .fn()
      .mockResolvedValue({ id: 'trusted-int', orgId: 'trusted-org' }),
  };
  const dispatcher = {
    dispatchById: jest.fn().mockResolvedValue('dispatched'),
  };
  const producer = new WebhookQueueProducer(
    events as never,
    integrations as never,
    dispatcher as never,
  );
  const params = {
    platform: 'shopify' as const,
    jobType: WebhookJobType.ORDER_CREATE,
    idempotencyKey: 'delivery-1',
    storeDomain: 'synthetic.myshopify.com',
    rawPayload: shopifyOrderFixture({
      orgId: 'forged-org',
      integrationId: 'forged-int',
    }),
  };
  return { producer, events, integrations, dispatcher, params };
}

describe('WebhookQueueProducer', () => {
  it('resolves trusted tenant identity and uses a stable job ID', async () => {
    const { producer, events, integrations, dispatcher, params } = setup();
    await expect(producer.ingest(params)).resolves.toEqual({ enqueued: true });
    expect(integrations.findByPlatformDomain).toHaveBeenCalledWith(
      params.storeDomain,
      'shopify',
    );
    expect(events.insertIfNew).toHaveBeenCalledWith({
      ...params,
      orgId: 'trusted-org',
      integrationId: 'trusted-int',
      dispatchRequired: true,
    });
    expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
  });

  it('acknowledges duplicates without enqueueing', async () => {
    const { producer, events, dispatcher, params } = setup();
    events.insertIfNew.mockResolvedValue(null);
    events.findBySourceAndIdempotency.mockResolvedValue({
      id: 'event-1',
    });
    dispatcher.dispatchById.mockResolvedValue('not_claimed');
    await expect(producer.ingest(params)).resolves.toEqual({
      enqueued: false,
      duplicate: true,
    });
    expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
  });

  it('persists unknown stores without trusting payload identity; the worker owns rejection', async () => {
    const { producer, events, integrations, params } = setup();
    integrations.findByPlatformDomain.mockResolvedValue(null);
    await producer.ingest(params);
    expect(events.insertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null, integrationId: null }),
    );
  });

  it.each(['lookup', 'insert'])(
    'propagates %s failures without enqueueing',
    async (failure) => {
      const { producer, events, integrations, dispatcher, params } = setup();
      const operation =
        failure === 'lookup'
          ? integrations.findByPlatformDomain
          : events.insertIfNew;
      operation.mockRejectedValue(new Error('database unavailable'));
      await expect(producer.ingest(params)).rejects.toThrow(
        'database unavailable',
      );
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
      if (failure === 'lookup')
        expect(events.insertIfNew).not.toHaveBeenCalled();
    },
  );

  it('acknowledges a durably inserted event when immediate dispatch fails', async () => {
    const { producer, events, dispatcher, params } = setup();
    events.insertIfNew
      .mockResolvedValueOnce({ id: 'event-1' })
      .mockResolvedValueOnce(null);
    events.findBySourceAndIdempotency.mockResolvedValue({ id: 'event-1' });
    dispatcher.dispatchById
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('dispatched');
    await expect(producer.ingest(params)).resolves.toEqual({ enqueued: false });
    await expect(producer.ingest(params)).resolves.toEqual({
      enqueued: true,
      duplicate: true,
    });
    expect(events.insertIfNew).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatchById).toHaveBeenCalledTimes(2);
  });

  it('still acknowledges durable acceptance if the dispatch claim store is briefly unavailable', async () => {
    const { producer, dispatcher, params } = setup();
    dispatcher.dispatchById.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(producer.ingest(params)).resolves.toEqual({ enqueued: false });
  });
});
