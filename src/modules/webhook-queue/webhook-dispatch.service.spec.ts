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
    dispatchLeaseUntil: '2026-09-03T00:00:30.000Z',
    ...overrides,
  };
}

function setup() {
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const events = {
    claimForDispatch: jest.fn().mockResolvedValue(event()),
    markDispatched: jest.fn(),
    markDispatchFailed: jest.fn(),
    findById: jest.fn().mockResolvedValue(event()),
  };
  const service = new WebhookDispatchService(
    queue as never,
    events as never,
    new ConfigService({ WEBHOOK_DISPATCH_MAX_ATTEMPTS: 3 }),
  );
  return { service, queue, events };
}

describe('WebhookDispatchService', () => {
  it('uses an atomic database claim and a per-claim BullMQ job ID', async () => {
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
        jobId: `webhook-event-event-1-dispatch-1-${Date.parse('2026-09-03T00:00:30.000Z')}`,
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
      expect.any(Number),
    );
  });

  it('never lets an unclaimed dispatch pass silently', async () => {
    const { service, events } = setup();
    events.claimForDispatch.mockResolvedValue(null);
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);

    await expect(service.dispatchById('event-1')).resolves.toBe('not_claimed');

    expect(events.findById).toHaveBeenCalledWith('event-1');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('"action":"webhook-dispatch"');
    expect(logged).toContain('"reason":"not_claimed"');
    expect(logged).toContain('"webhookEventId":"event-1"');
  });

  it('gives each claim of the same event a distinct job ID so a re-dispatch cannot be deduped', async () => {
    const { service, queue, events } = setup();
    // `resetForRedispatch` rewinds dispatchAttempts, so a retry re-uses the
    // original attempt number; only the fresh lease distinguishes the claims.
    events.claimForDispatch
      .mockResolvedValueOnce(
        event({ dispatchLeaseUntil: '2026-09-03T00:00:30.000Z' }),
      )
      .mockResolvedValueOnce(
        event({ dispatchLeaseUntil: '2026-09-03T01:00:30.000Z' }),
      );

    await service.dispatchById('event-1');
    await service.dispatchById('event-1');

    const jobIds = queue.add.mock.calls.map(
      (call: [string, unknown, { jobId: string }]) => call[2].jobId,
    );
    expect(jobIds).toHaveLength(2);
    expect(new Set(jobIds).size).toBe(2);
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
