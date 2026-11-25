import { WebhookQueueProducer } from './webhook-queue.producer';
import { WebhookJobType } from './webhook-queue.constants';

function setup(integration: Record<string, unknown> | null) {
  const events = {
    insertIfNew: jest.fn().mockResolvedValue({ id: 'event-1' }),
    findBySourceAndIdempotency: jest.fn(),
  };
  const integrations = {
    findByPlatformDomain: jest.fn().mockResolvedValue(integration),
  };
  const dispatcher = {
    dispatchById: jest.fn().mockResolvedValue('dispatched'),
  };
  const producer = new WebhookQueueProducer(
    events as never,
    integrations as never,
    dispatcher as never,
  );
  return { producer, events, integrations, dispatcher };
}

const params = {
  platform: 'shopify' as const,
  jobType: WebhookJobType.ORDER_UPDATE,
  idempotencyKey: 'w-1',
  storeDomain: 'shop.myshopify.com',
  rawPayload: { id: '1' },
};

describe('WebhookQueueProducer admit', () => {
  it('drops a refused event after the integration lookup, storing nothing', async () => {
    const { producer, events, integrations, dispatcher } = setup({
      id: 'int-1',
      orgId: 'org-1',
      shippingNotificationsEnabled: false,
    });
    const admit = jest.fn(() => 'shipping_feature_off');
    await expect(producer.ingest({ ...params, admit })).resolves.toEqual({
      enqueued: false,
    });
    expect(integrations.findByPlatformDomain).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-1' }),
    );
    expect(events.insertIfNew).not.toHaveBeenCalled();
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });

  it('stores and dispatches an admitted event, without the predicate', async () => {
    const { producer, events, dispatcher } = setup({
      id: 'int-1',
      orgId: 'org-1',
    });
    await expect(
      producer.ingest({ ...params, admit: () => null }),
    ).resolves.toEqual({ enqueued: true });
    expect(events.insertIfNew).toHaveBeenCalledWith({
      platform: 'shopify',
      jobType: WebhookJobType.ORDER_UPDATE,
      idempotencyKey: 'w-1',
      storeDomain: 'shop.myshopify.com',
      orgId: 'org-1',
      integrationId: 'int-1',
      rawPayload: { id: '1' },
      dispatchRequired: true,
    });
    expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
  });

  it('never asks the predicate for an unknown store', async () => {
    const { producer, events } = setup(null);
    const admit = jest.fn(() => null);
    await producer.ingest({ ...params, admit });
    expect(admit).not.toHaveBeenCalled();
    expect(events.insertIfNew).not.toHaveBeenCalled();
  });
});
