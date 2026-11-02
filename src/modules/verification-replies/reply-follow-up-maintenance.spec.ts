import { Logger } from '@nestjs/common';
import {
  ReplyFollowUpMaintenanceProcessor,
  ReplyFollowUpMaintenanceScheduler,
} from './reply-follow-up-maintenance';

describe('thank-you billing maintenance', () => {
  afterEach(() => jest.restoreAllMocks());

  it('schedules bounded sweeps independently of the sending switch', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    await new ReplyFollowUpMaintenanceScheduler(queue as never).ensure();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'expire-acknowledgment-leases',
      { every: 60_000 },
      expect.objectContaining({
        name: 'expire-acknowledgment-leases',
        opts: {
          attempts: 1,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      }),
    );
  });

  it('parks expired leases without sending or retrying messages', async () => {
    const dispatches = {
      expireAcknowledgmentLeases: jest.fn().mockResolvedValue(2),
    };
    const worker = new ReplyFollowUpMaintenanceProcessor(dispatches as never);
    await worker.process({ name: 'expire-acknowledgment-leases' } as never);
    expect(dispatches.expireAcknowledgmentLeases).toHaveBeenCalledTimes(1);
  });

  it('logs a scheduling failure without blocking application startup', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const queue = {
      upsertJobScheduler: jest
        .fn()
        .mockRejectedValue(new Error('queue unavailable')),
    };
    await expect(
      new ReplyFollowUpMaintenanceScheduler(queue as never).ensure(),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
