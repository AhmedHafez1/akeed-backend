import { InternalServerErrorException, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { MetaWebhookEventsProcessor } from './meta-webhook-events.processor';
import { MetaWebhookEventsScheduler } from './meta-webhook-events.scheduler';
import { MetaWebhookEventsService } from './meta-webhook-events.service';
import {
  META_WEBHOOK_MAX_ATTEMPTS,
  META_WEBHOOK_PURGE_SCHEDULER,
  META_WEBHOOK_SWEEP_BATCH,
  META_WEBHOOK_SWEEP_SCHEDULER,
} from './meta-webhook-queue.constants';

const body = JSON.stringify({
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {} }] }],
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    field: 'messages',
    payload: body,
    attempts: 1,
    ...overrides,
  };
}

function setup() {
  const queue = { addBulk: jest.fn().mockResolvedValue([]) };
  const events = {
    insertMany: jest.fn().mockResolvedValue([{ id: 'event-1' }]),
    claim: jest.fn().mockResolvedValue(event()),
    markSucceeded: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    failExhausted: jest.fn().mockResolvedValue(0),
    claimDue: jest.fn().mockResolvedValue([]),
    purge: jest.fn().mockResolvedValue({ payloadsCleared: 0, rowsDeleted: 0 }),
  };
  const messages = {
    processIncomingOrThrow: jest.fn().mockResolvedValue(undefined),
  };
  const templates = { handleOrThrow: jest.fn().mockResolvedValue(undefined) };
  const service = new MetaWebhookEventsService(
    queue as never,
    events as never,
    messages as never,
    templates as never,
  );
  return { service, queue, events, messages, templates };
}

describe('MetaWebhookEventsService', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('accept', () => {
    it('stores, then queues only the id', async () => {
      const { service, queue, events } = setup();

      await service.accept(Buffer.from(body));

      expect(events.insertMany).toHaveBeenCalledTimes(1);
      await new Promise(setImmediate);
      const [[jobs]] = queue.addBulk.mock.calls as [
        [{ data: unknown; opts: { jobId: string; attempts: number } }[]],
      ];
      expect(jobs[0].data).toEqual({ eventId: 'event-1' });
      expect(jobs[0].opts).toMatchObject({
        jobId: 'meta-event-event-1',
        attempts: META_WEBHOOK_MAX_ATTEMPTS,
      });
    });

    it('answers 500 when the database cannot store the event', async () => {
      const { service, queue, events } = setup();
      events.insertMany.mockRejectedValue(new Error('database down'));

      await expect(service.accept(Buffer.from(body))).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );

      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    it('does not wait for Redis before answering', async () => {
      const { service, queue } = setup();
      queue.addBulk.mockReturnValue(new Promise(() => undefined));

      await expect(service.accept(Buffer.from(body))).resolves.toBeUndefined();
    });

    it('answers normally and logs when queueing fails', async () => {
      const { service, queue } = setup();
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      queue.addBulk.mockRejectedValue(new Error('redis down'));

      await expect(service.accept(Buffer.from(body))).resolves.toBeUndefined();
      await new Promise(setImmediate);

      expect(logged).toHaveBeenCalledTimes(1);
    });

    it('queues nothing for a duplicate delivery', async () => {
      const { service, queue, events } = setup();
      events.insertMany.mockResolvedValue([]);

      await service.accept(Buffer.from(body));

      expect(queue.addBulk).not.toHaveBeenCalled();
    });
  });

  describe('process', () => {
    it('runs both handlers and clears the event', async () => {
      const { service, events, messages, templates } = setup();

      await service.process('event-1');

      expect(messages.processIncomingOrThrow).toHaveBeenCalledWith(
        expect.anything(),
        { isRetry: false },
      );
      expect(templates.handleOrThrow).toHaveBeenCalledWith(Buffer.from(body));
      expect(events.markSucceeded).toHaveBeenCalledWith('event-1', 1);
    });

    it('tells the handler a later run is a retry', async () => {
      const { service, events, messages } = setup();
      events.claim.mockResolvedValue(event({ attempts: 2 }));

      await service.process('event-1');

      expect(messages.processIncomingOrThrow).toHaveBeenCalledWith(
        expect.anything(),
        { isRetry: true },
      );
    });

    it('does nothing when another run holds the event', async () => {
      const { service, events, messages } = setup();
      events.claim.mockResolvedValue(undefined);

      await service.process('event-1');

      expect(messages.processIncomingOrThrow).not.toHaveBeenCalled();
      expect(events.markSucceeded).not.toHaveBeenCalled();
    });

    it('releases a failed run and rethrows for a retry', async () => {
      const { service, events, messages } = setup();
      const failure = new Error('database down');
      messages.processIncomingOrThrow.mockRejectedValue(failure);

      await expect(service.process('event-1')).rejects.toBe(failure);

      expect(events.release).toHaveBeenCalledWith(
        'event-1',
        1,
        'database down',
        expect.any(String),
      );
      expect(events.markSucceeded).not.toHaveBeenCalled();
      expect(events.markFailed).not.toHaveBeenCalled();
    });

    it('still rethrows when the failure cannot be recorded', async () => {
      const { service, events, messages } = setup();
      const failure = new Error('database down');
      messages.processIncomingOrThrow.mockRejectedValue(failure);
      events.release.mockRejectedValue(new Error('still down'));

      await expect(service.process('event-1')).rejects.toBe(failure);
    });

    it('marks the event failed after its last attempt', async () => {
      const { service, events, messages } = setup();
      events.claim.mockResolvedValue(
        event({ attempts: META_WEBHOOK_MAX_ATTEMPTS }),
      );
      messages.processIncomingOrThrow.mockRejectedValue(new Error('broken'));

      await expect(service.process('event-1')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        META_WEBHOOK_MAX_ATTEMPTS,
        'broken',
      );
      expect(events.release).not.toHaveBeenCalled();
    });

    it('fails an unsplittable body without retrying or running a handler', async () => {
      const { service, events, messages } = setup();
      events.claim.mockResolvedValue(
        event({ payload: '{"object":"x"}', field: null }),
      );

      await expect(service.process('event-1')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        1,
        'unsplittable_body',
      );
      expect(messages.processIncomingOrThrow).not.toHaveBeenCalled();
    });

    it('fails an event that fails DTO validation without retrying', async () => {
      const { service, events, messages, templates } = setup();
      events.claim.mockResolvedValue(
        event({
          payload: JSON.stringify({
            entry: [
              {
                id: 'waba',
                changes: [{ field: 'messages', value: { messages: 'nope' } }],
              },
            ],
          }),
        }),
      );

      await expect(service.process('event-1')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(events.markFailed).toHaveBeenCalledWith(
        'event-1',
        1,
        'validation_failed',
      );
      expect(messages.processIncomingOrThrow).not.toHaveBeenCalled();
      expect(templates.handleOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('sweep', () => {
    it('queues due rows under a jobId BullMQ has not seen', async () => {
      const { service, queue, events } = setup();
      events.claimDue.mockResolvedValue([{ id: 'event-1', attempts: 2 }]);

      await expect(service.sweep()).resolves.toEqual({ failed: 0, queued: 1 });
      await service.sweep();

      const jobIds = (
        queue.addBulk.mock.calls as [{ opts: { jobId: string } }[]][]
      ).map(([jobs]) => jobs[0].opts.jobId);
      expect(jobIds[0]).toMatch(/^meta-event-event-1-2-\d+$/);
      expect(jobIds[0]).not.toBe('meta-event-event-1');
    });

    it('takes another batch only after a full one', async () => {
      const { service, events } = setup();
      const full = Array.from({ length: META_WEBHOOK_SWEEP_BATCH }, (_, i) => ({
        id: `event-${i}`,
        attempts: 0,
      }));
      events.claimDue
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce([{ id: 'last', attempts: 0 }]);

      await expect(service.sweep()).resolves.toMatchObject({
        queued: META_WEBHOOK_SWEEP_BATCH + 1,
      });

      expect(events.claimDue).toHaveBeenCalledTimes(2);
    });

    it('stops without throwing when Redis fails', async () => {
      const { service, queue, events } = setup();
      events.claimDue.mockResolvedValue([{ id: 'event-1', attempts: 0 }]);
      queue.addBulk.mockRejectedValue(new Error('redis down'));

      await expect(service.sweep()).resolves.toEqual({ failed: 0, queued: 0 });

      expect(events.claimDue).toHaveBeenCalledTimes(1);
    });
  });

  it('purges with the owner retention windows', async () => {
    const { service, events } = setup();

    await service.purge();

    expect(events.purge).toHaveBeenCalledWith(14, 30);
  });
});

describe('MetaWebhookEventsProcessor', () => {
  it.each([
    ['process', 'process', [{ eventId: 'event-1' }]],
    ['sweep', 'sweep', []],
    ['purge', 'purge', []],
  ])('routes %s jobs', async (name, method, data) => {
    const events = {
      process: jest.fn(),
      sweep: jest.fn(),
      purge: jest.fn(),
    };
    const processor = new MetaWebhookEventsProcessor(events as never);

    await processor.process({ name, data: data[0] ?? {} } as never);

    expect(events[method as keyof typeof events]).toHaveBeenCalledTimes(1);
  });
});

describe('MetaWebhookEventsScheduler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the sweep and the purge running with no switch to read', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };

    await new MetaWebhookEventsScheduler(queue as never).ensure();

    expect(
      queue.upsertJobScheduler.mock.calls.map(([name]: [string]) => name),
    ).toEqual([META_WEBHOOK_SWEEP_SCHEDULER, META_WEBHOOK_PURGE_SCHEDULER]);
  });

  it('logs a queue failure instead of stopping boot', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockRejectedValue(new Error('redis down')),
    };

    await expect(
      new MetaWebhookEventsScheduler(queue as never).ensure(),
    ).resolves.toBeUndefined();
  });
});
