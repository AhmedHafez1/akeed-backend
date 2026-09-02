import { WebhookQueueProducer } from './webhook-queue.producer';
import { WebhookJobType } from './webhook-queue.constants';
import { shopifyOrderFixture } from './normalizers/fixtures/shopify-order.fixture';

function setup() {
  const queue = { add: jest.fn().mockResolvedValue({ id: 'queued' }) };
  const events = {
    insertIfNew: jest.fn().mockResolvedValue({
      id: 'event-1',
      receivedAt: '2026-05-15T00:00:00.000Z',
    }),
  };
  const integrations = {
    findByPlatformDomain: jest
      .fn()
      .mockResolvedValue({ id: 'trusted-int', orgId: 'trusted-org' }),
  };
  const producer = new WebhookQueueProducer(
    queue as never,
    events as never,
    integrations as never,
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
  return { producer, queue, events, integrations, params };
}

describe('WebhookQueueProducer', () => {
  it('resolves trusted tenant identity and uses a stable job ID', async () => {
    const { producer, queue, events, integrations, params } = setup();
    await expect(producer.ingest(params)).resolves.toEqual({ enqueued: true });
    expect(integrations.findByPlatformDomain).toHaveBeenCalledWith(
      params.storeDomain,
      'shopify',
    );
    expect(events.insertIfNew).toHaveBeenCalledWith({
      ...params,
      orgId: 'trusted-org',
      integrationId: 'trusted-int',
    });
    expect(queue.add).toHaveBeenCalledWith(
      WebhookJobType.ORDER_CREATE,
      {
        webhookEventId: 'event-1',
        platform: 'shopify',
        jobType: WebhookJobType.ORDER_CREATE,
        idempotencyKey: 'delivery-1',
        storeDomain: params.storeDomain,
        orgId: 'trusted-org',
        integrationId: 'trusted-int',
        rawPayload: params.rawPayload,
        receivedAt: '2026-05-15T00:00:00.000Z',
      },
      expect.objectContaining({
        jobId: 'shopify-delivery-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
      }),
    );
  });

  it('acknowledges duplicates without enqueueing', async () => {
    const { producer, queue, events, params } = setup();
    events.insertIfNew.mockResolvedValue(null);
    await expect(producer.ingest(params)).resolves.toEqual({
      enqueued: false,
      duplicate: true,
    });
    expect(queue.add).not.toHaveBeenCalled();
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
      const { producer, queue, events, integrations, params } = setup();
      const operation =
        failure === 'lookup'
          ? integrations.findByPlatformDomain
          : events.insertIfNew;
      operation.mockRejectedValue(new Error('database unavailable'));
      await expect(producer.ingest(params)).rejects.toThrow(
        'database unavailable',
      );
      expect(queue.add).not.toHaveBeenCalled();
      if (failure === 'lookup')
        expect(events.insertIfNew).not.toHaveBeenCalled();
    },
  );

  it('US-02-06 limitation: failed enqueue leaves an inserted event unrecovered on duplicate redelivery', async () => {
    const { producer, queue, events, params } = setup();
    events.insertIfNew
      .mockResolvedValueOnce({ id: 'event-1' })
      .mockResolvedValueOnce(null);
    queue.add.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(producer.ingest(params)).rejects.toThrow('queue unavailable');
    await expect(producer.ingest(params)).resolves.toEqual({
      enqueued: false,
      duplicate: true,
    });
    expect(events.insertIfNew).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
