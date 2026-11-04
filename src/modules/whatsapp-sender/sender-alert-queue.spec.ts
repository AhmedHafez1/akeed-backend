import {
  SenderAlertProcessor,
  SenderAlertProducer,
} from './sender-alert-queue';
import { SenderEventsService } from './sender-events.service';

describe('sender alert background queue', () => {
  it('returns before Redis or email can finish and contains enqueue rejection', async () => {
    let reject!: (reason: Error) => void;
    const queue = {
      add: jest.fn().mockImplementation(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      ),
    };
    const producer = new SenderAlertProducer(queue as never);
    const events = new SenderEventsService(producer);
    await expect(
      events.emit({
        orgId: 'org',
        connectionId: 'connection',
        signupGeneration: 2,
        kind: 'changed',
        dedupeKey: 'event',
      }),
    ).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledWith(
      'evaluate',
      { orgId: 'org', signupGeneration: 2 },
      expect.anything(),
    );
    reject(new Error('queue unavailable'));
    await Promise.resolve();
  });
  it('schedules every two minutes and contains scheduler failure', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    const producer = new SenderAlertProducer(queue as never);
    await producer.schedule();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'sender-alert-sweep',
      { every: 120000 },
      expect.anything(),
    );
    queue.upsertJobScheduler.mockRejectedValue(new Error('queue unavailable'));
    await expect(producer.schedule()).resolves.toBeUndefined();
  });
  it('uses a new job identity after a minute so retained failures cannot block recovery', () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const producer = new SenderAlertProducer(queue as never);
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(60_000);
      producer.request('org', 1);
      now.mockReturnValue(120_000);
      producer.request('org', 1);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        'evaluate',
        { orgId: 'org', signupGeneration: 1 },
        expect.objectContaining({ jobId: 'wa-alert-org-1-1' }),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
        'evaluate',
        { orgId: 'org', signupGeneration: 1 },
        expect.objectContaining({ jobId: 'wa-alert-org-1-2' }),
      );
    } finally {
      now.mockRestore();
    }
  });
  it('evaluates generation-scoped work without running a sweep', async () => {
    const service = { evaluate: jest.fn() };
    const processor = new SenderAlertProcessor(
      service as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await processor.process({
      name: 'evaluate',
      data: { orgId: 'org', signupGeneration: 3 },
    } as never);
    expect(service.evaluate).toHaveBeenCalledWith('org', 3);
  });
  it('pages through a sweep in bounded jobs and stops after the last page', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      id: `connection-${i}`,
      orgId: `org-${i}`,
      signupGeneration: 1,
    }));
    const alerts = { listConnections: jest.fn().mockResolvedValue(page) };
    const producer = { request: jest.fn() };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const processor = new SenderAlertProcessor(
      {} as never,
      alerts as never,
      producer as never,
      queue as never,
    );
    await processor.process({ name: 'sweep', data: {} } as never);
    expect(alerts.listConnections).toHaveBeenCalledWith(undefined);
    expect(producer.request).toHaveBeenCalledTimes(50);
    expect(queue.add).toHaveBeenCalledWith(
      'sweep',
      { after: 'connection-49' },
      expect.anything(),
    );
    alerts.listConnections.mockResolvedValue([page[0]]);
    queue.add.mockClear();
    await processor.process({
      name: 'sweep',
      data: { after: 'connection-49' },
    } as never);
    expect(alerts.listConnections).toHaveBeenLastCalledWith('connection-49');
    expect(queue.add).not.toHaveBeenCalled();
  });
});
