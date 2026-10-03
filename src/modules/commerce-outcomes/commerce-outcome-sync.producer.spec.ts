import type { Queue } from 'bullmq';
import type { CommerceOutcomeSyncJobPayload } from './commerce-outcome-sync.constants';
import {
  CommerceOutcomeSyncProducer,
  type OutcomeSyncRetry,
} from './commerce-outcome-sync.producer';

/** BullMQ's rule: an `add` whose job id already exists adds nothing. */
function setup() {
  const jobs = new Map<string, CommerceOutcomeSyncJobPayload>();
  const queue = {
    add: jest.fn(
      (
        _name: string,
        payload: CommerceOutcomeSyncJobPayload,
        options: { jobId: string },
      ) => {
        if (!jobs.has(options.jobId)) jobs.set(options.jobId, payload);
        return Promise.resolve();
      },
    ),
  };
  const producer = new CommerceOutcomeSyncProducer(
    queue as unknown as Queue<CommerceOutcomeSyncJobPayload>,
  );
  return { producer, jobs };
}

const retry: OutcomeSyncRetry = {
  syncId: 'sync-1',
  orgId: 'org-1',
  attempts: 1,
  deferrals: 0,
  dueAt: 1_800_000_000_000,
  delayMs: 30_000,
};

describe('CommerceOutcomeSyncProducer', () => {
  it('adds one job when the same retry is scheduled twice', async () => {
    const { producer, jobs } = setup();

    await producer.scheduleRetry(retry);
    await producer.scheduleRetry(retry);

    expect(jobs.size).toBe(1);
  });

  it('adds a new job when a merchant retry rewinds the counters to the same values', async () => {
    const { producer, jobs } = setup();

    await producer.scheduleRetry(retry);
    // After resetForRetry the next failed try has attempts 1, deferrals 0 again.
    await producer.scheduleRetry({ ...retry, dueAt: retry.dueAt + 90_000 });

    expect(jobs.size).toBe(2);
  });

  it('keeps the job id free of the characters BullMQ refuses', async () => {
    const { producer, jobs } = setup();

    await producer.scheduleRetry(retry);

    expect([...jobs.keys()][0]).toMatch(/^[A-Za-z0-9-]+$/);
  });
});
