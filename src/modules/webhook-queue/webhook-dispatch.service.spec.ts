import { ConfigService } from '@nestjs/config';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookJobType } from './webhook-queue.constants';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    platform: 'shopify',
    jobType: WebhookJobType.ORDER_CREATE,
    idempotencyKey: 'delivery-1',
    storeDomain: 'one.myshopify.com',
    orgId: 'org-1',
    integrationId: 'int-1',
    rawPayload: { id: 'order-1' },
    receivedAt: '2026-09-03T00:00:00.000Z',
    dispatchAttempts: 1,
    ...overrides,
  };
}

function setup() {
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const events = {
    claimForDispatch: jest.fn().mockResolvedValue(event()),
    markDispatched: jest.fn(),
    markDispatchFailed: jest.fn(),
  };
  const service = new WebhookDispatchService(
    queue as never,
    events as never,
    new ConfigService({ WEBHOOK_DISPATCH_MAX_ATTEMPTS: 3 }),
  );
  return { service, queue, events };
}

describe('WebhookDispatchService', () => {
  it('uses an atomic database claim and a stable event-based BullMQ job ID', async () => {
    const { service, queue, events } = setup();
    await expect(service.dispatchById('event-1')).resolves.toBe('dispatched');
    expect(events.claimForDispatch).toHaveBeenCalledWith(
      'event-1',
      expect.any(String),
      expect.any(String),
      3,
    );
    expect(queue.add).toHaveBeenCalledWith(
      WebhookJobType.ORDER_CREATE,
      expect.objectContaining({ webhookEventId: 'event-1' }),
      expect.objectContaining({
        jobId: 'webhook-event-event-1-dispatch-1',
      }),
    );
    expect(events.markDispatched).toHaveBeenCalledWith('event-1');
  });

  it('allows only the winner of a concurrent claim to enqueue', async () => {
    const { service, queue, events } = setup();
    events.claimForDispatch
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(null);
    await expect(
      Promise.all([
        service.dispatchById('event-1'),
        service.dispatchById('event-1'),
      ]),
    ).resolves.toEqual(expect.arrayContaining(['dispatched', 'not_claimed']));
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('records queue failure for bounded retry after durable persistence', async () => {
    const { service, queue, events } = setup();
    queue.add.mockRejectedValue(new Error('redis unavailable'));
    await expect(service.dispatchById('event-1')).resolves.toBe('failed');
    expect(events.markDispatchFailed).toHaveBeenCalledWith(
      'event-1',
      'redis unavailable',
      false,
      expect.any(String),
    );
  });

  it('records a terminal dispatch failure when the retry limit is reached', async () => {
    const { service, queue, events } = setup();
    events.claimForDispatch.mockResolvedValue(event({ dispatchAttempts: 3 }));
    queue.add.mockRejectedValue(new Error('redis unavailable'));
    await service.dispatchById('event-1');
    expect(events.markDispatchFailed).toHaveBeenCalledWith(
      'event-1',
      'redis unavailable',
      true,
      null,
    );
  });
});
