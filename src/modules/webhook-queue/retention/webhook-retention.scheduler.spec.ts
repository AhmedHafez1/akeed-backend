import { ConfigService } from '@nestjs/config';
import { WebhookRetentionScheduler } from './webhook-retention.scheduler';
import { WebhookRetentionService } from './webhook-retention.service';
import {
  WEBHOOK_RETENTION_EVERY_MS,
  WEBHOOK_RETENTION_JOB,
  WEBHOOK_RETENTION_SCHEDULER,
} from './webhook-retention.constants';

describe('WebhookRetentionScheduler', () => {
  const queue = {
    upsertJobScheduler: jest.fn(),
    removeJobScheduler: jest.fn(),
  };

  beforeEach(() => jest.resetAllMocks());

  it('keeps one hourly schedule by default', async () => {
    await new WebhookRetentionScheduler(
      queue as never,
      new ConfigService({}),
    ).ensure();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      WEBHOOK_RETENTION_SCHEDULER,
      { every: WEBHOOK_RETENTION_EVERY_MS },
      expect.objectContaining({ name: WEBHOOK_RETENTION_JOB }),
    );
    const [, , template] = queue.upsertJobScheduler.mock.calls[0] as [
      string,
      unknown,
      { opts: { attempts: number } },
    ];
    expect(template.opts.attempts).toBe(1);
  });

  it('removes the schedule when switched off', async () => {
    await new WebhookRetentionScheduler(
      queue as never,
      new ConfigService({ WEBHOOK_RETENTION_ENABLED: 'false' }),
    ).ensure();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(
      WEBHOOK_RETENTION_SCHEDULER,
    );
  });

  it('never throws when the queue is unavailable', async () => {
    queue.upsertJobScheduler.mockRejectedValue(new Error('redis down'));
    await expect(
      new WebhookRetentionScheduler(
        queue as never,
        new ConfigService({}),
      ).ensure(),
    ).resolves.toBeUndefined();
  });
});

describe('WebhookRetentionService', () => {
  it('logs counts only', async () => {
    const result = {
      deleted: { unlinked_finished: 3, no_store: 1, before_uninstall: 0 },
      scrubbed: 2,
      passes: 4,
      truncated: false,
    };
    const repository = { run: jest.fn().mockResolvedValue(result) };
    const intake = {
      deleteOlderThan: jest
        .fn()
        .mockResolvedValue({ orders: 5, buckets: 2, truncated: false }),
    };
    const now = new Date('2026-11-12T00:00:00.000Z');
    const service = new WebhookRetentionService(
      repository as never,
      intake as never,
    );
    const log = jest
      .spyOn(service['logger'], 'log')
      .mockImplementation(() => undefined);

    await expect(service.run(now)).resolves.toEqual(result);
    expect(intake.deleteOlderThan).toHaveBeenCalledWith(
      new Date('2026-08-14T00:00:00.000Z'),
    );

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('"deletedUnlinkedFinished":3');
    expect(line).toContain('"scrubbedWooCommerceMarkers":2');
    expect(line).toContain('"deletedIntakeOrders":5');
    expect(line).toContain('"deletedIntakeBuckets":2');
    expect(line).not.toMatch(/raw_payload|phone|customer/i);
  });
});
