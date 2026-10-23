import { VerificationAutomationJobType } from './verification-automation.constants';
import { VerificationAutomationProducer } from './verification-automation.producer';

describe('VerificationAutomationProducer', () => {
  const queue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };

  let producer: VerificationAutomationProducer;

  beforeEach(() => {
    jest.clearAllMocks();
    queue.getJob.mockResolvedValue(undefined);
    producer = new VerificationAutomationProducer(queue as never);
  });

  it.each([
    [
      'enqueueInitialSend',
      VerificationAutomationJobType.INITIAL_SEND,
      'initial',
    ],
    ['enqueueFollowUp', VerificationAutomationJobType.FOLLOW_UP, 'follow-up-1'],
    [
      'enqueueNoReplyEscalation',
      VerificationAutomationJobType.ESCALATE_NO_REPLY,
      'no-reply',
    ],
  ] as const)(
    'uses a BullMQ-safe job id for %s',
    async (methodName, jobType, suffix) => {
      const dueAt = new Date(Date.now() + 60_000);

      await producer[methodName]({
        verificationId: 'akeed-test-1777711017900',
        orgId: 'org_123',
        dueAt,
      });

      expect(queue.add).toHaveBeenCalledWith(
        jobType,
        expect.objectContaining({
          verificationId: 'akeed-test-1777711017900',
          orgId: 'org_123',
          scheduledAt: dueAt.toISOString(),
        }),
        expect.objectContaining({
          jobId: `verification-akeed-test-1777711017900-${suffix}`,
        }),
      );
    },
  );

  it.each([
    [
      'enqueueAcknowledgment',
      VerificationAutomationJobType.ACKNOWLEDGMENT,
      'acknowledgment',
      'confirmed',
    ],
    [
      'enqueueUnresolvedReplyNudge',
      VerificationAutomationJobType.UNRESOLVED_REPLY_NUDGE,
      'nudge',
      undefined,
    ],
  ] as const)(
    '%s is due now, attempted once, under one job id per verification',
    async (methodName, jobType, suffix, intent) => {
      await producer[methodName]({
        verificationId: 'ver-1',
        orgId: 'org-1',
        repliedAt: '2026-10-06T12:00:00.000Z',
        ...(intent ? { intent } : {}),
      });

      expect(queue.add).toHaveBeenCalledWith(
        jobType,
        expect.objectContaining({
          verificationId: 'ver-1',
          orgId: 'org-1',
          reply: {
            repliedAt: '2026-10-06T12:00:00.000Z',
            ...(intent ? { intent } : {}),
          },
        }),
        expect.objectContaining({
          jobId: `verification-ver-1-${suffix}`,
          attempts: 1,
        }),
      );
      const [, , options] = queue.add.mock.calls[0] as [
        string,
        unknown,
        Record<string, unknown>,
      ];
      expect(options).not.toHaveProperty('delay');
    },
  );

  describe('enqueueInitialSend after an earlier send ran', () => {
    const params = {
      verificationId: 'ver-1',
      orgId: 'org-1',
      dueAt: new Date(Date.now() + 60_000),
    };

    it.each(['completed', 'failed'])(
      'replaces a %s job so the reopened send runs',
      async (state) => {
        const job = {
          getState: jest.fn().mockResolvedValue(state),
          remove: jest.fn().mockResolvedValue(undefined),
        };
        queue.getJob.mockResolvedValue(job);

        await producer.enqueueInitialSend(params);

        expect(queue.getJob).toHaveBeenCalledWith('verification-ver-1-initial');
        expect(job.remove).toHaveBeenCalledTimes(1);
        expect(queue.add).toHaveBeenCalledWith(
          VerificationAutomationJobType.INITIAL_SEND,
          expect.anything(),
          expect.objectContaining({ jobId: 'verification-ver-1-initial' }),
        );
      },
    );

    it.each(['delayed', 'waiting', 'active'])(
      'keeps a %s job, so a repeated request is a no-op',
      async (state) => {
        const job = {
          getState: jest.fn().mockResolvedValue(state),
          remove: jest.fn(),
        };
        queue.getJob.mockResolvedValue(job);

        await producer.enqueueInitialSend(params);

        expect(job.remove).not.toHaveBeenCalled();
        expect(queue.add).toHaveBeenCalledTimes(1);
      },
    );

    it('still adds the job when the lookup fails', async () => {
      queue.getJob.mockRejectedValue(new Error('redis down'));

      await producer.enqueueInitialSend(params);

      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('never touches a finished reminder', async () => {
      await producer.enqueueFollowUp(params);

      expect(queue.getJob).not.toHaveBeenCalled();
    });
  });

  describe('readFollowUpJob', () => {
    const params = { verificationId: 'v1', orgId: 'org-1' };

    it.each([
      ['delayed', 'pending'],
      ['waiting', 'pending'],
      ['prioritized', 'pending'],
      ['active', 'pending'],
      ['completed', 'will_not_run'],
      ['failed', 'will_not_run'],
      ['unknown', 'will_not_run'],
    ])('reads a %s reminder as %s', async (state, expected) => {
      queue.getJob.mockResolvedValue({
        getState: jest.fn().mockResolvedValue(state),
      });

      await expect(producer.readFollowUpJob(params)).resolves.toBe(expected);
      expect(queue.getJob).toHaveBeenCalledWith('verification-v1-follow-up-1');
    });

    it('reads a reminder that was never scheduled as one that will not run', async () => {
      await expect(producer.readFollowUpJob(params)).resolves.toBe(
        'will_not_run',
      );
    });

    it('reports a queue error instead of throwing', async () => {
      queue.getJob.mockRejectedValue(new Error('redis down'));

      await expect(producer.readFollowUpJob(params)).resolves.toBe(
        'lookup_failed',
      );
    });
  });
});
