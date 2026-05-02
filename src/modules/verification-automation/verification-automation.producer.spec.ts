import { VerificationAutomationJobType } from './verification-automation.constants';
import { VerificationAutomationProducer } from './verification-automation.producer';

describe('VerificationAutomationProducer', () => {
  const queue = {
    add: jest.fn(),
  };

  let producer: VerificationAutomationProducer;

  beforeEach(() => {
    jest.clearAllMocks();
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
});
