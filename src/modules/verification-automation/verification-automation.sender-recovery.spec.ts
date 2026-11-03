import type { Job } from 'bullmq';
import { VerificationAutomationProcessor } from './verification-automation.processor';
import { VerificationAutomationProducer } from './verification-automation.producer';
import {
  VerificationAutomationJobType as Kind,
  type VerificationAutomationJobPayload,
} from './verification-automation.constants';

describe('durable sender recovery worker', () => {
  function setup() {
    const sender = {
      resumeSenderRecovery: jest.fn().mockResolvedValue({
        status: 'sent',
        sentAt: '2026-11-03T12:00:00Z',
        recoveryKind: 'initial',
      }),
      acknowledgeRecoveryAutomation: jest.fn().mockResolvedValue(undefined),
      hasSenderRecovery: jest.fn().mockResolvedValue(true),
      sweepSenderRecovery: jest.fn().mockResolvedValue(undefined),
    };
    const verifications = {
      findById: jest.fn().mockResolvedValue({
        id: 'verification',
        orgId: 'org',
        orderId: 'order',
        status: 'sent',
      }),
    };
    const orders = {
      findById: jest.fn().mockResolvedValue({
        id: 'order',
        orgId: 'org',
        integrationId: 'integration',
        integration: { id: 'integration', orgId: 'org', isActive: true },
      }),
    };
    const hub = {
      scheduleFollowUpAndEscalation: jest.fn().mockResolvedValue(undefined),
    };
    const producer = {
      prepareRecoverySchedule: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new VerificationAutomationProcessor(
      verifications as never,
      orders as never,
      sender as never,
      hub as never,
      {} as never,
      {} as never,
      producer as never,
    );
    const job = (name: Kind) =>
      ({
        name,
        data: {
          orgId: 'org',
          verificationId: 'verification',
          dispatchId: 'dispatch',
          scheduledAt: '2026-11-03T12:00:00Z',
        },
      }) as Job<VerificationAutomationJobPayload>;
    return { sender, verifications, orders, hub, producer, processor, job };
  }
  it.each([Kind.SENDER_RETRY, Kind.SENDER_FALLBACK])(
    'reschedules from accepted replacement before acknowledging %s',
    async (kind) => {
      const s = setup();
      await s.processor.process(s.job(kind));
      expect(s.hub.scheduleFollowUpAndEscalation).toHaveBeenCalledWith(
        expect.objectContaining({
          baselineSentAt: new Date('2026-11-03T12:00:00Z'),
          reminderAlreadySent: false,
        }),
      );
      expect(s.sender.acknowledgeRecoveryAutomation).toHaveBeenCalledWith(
        'org',
        'dispatch',
      );
      expect(
        s.hub.scheduleFollowUpAndEscalation.mock.invocationCallOrder[0],
      ).toBeLessThan(
        s.sender.acknowledgeRecoveryAutomation.mock.invocationCallOrder[0],
      );
    },
  );
  it('does not acknowledge a failed scheduling operation', async () => {
    const s = setup();
    s.hub.scheduleFollowUpAndEscalation.mockRejectedValue(
      new Error('synthetic queue outage'),
    );
    await expect(s.processor.process(s.job(Kind.SENDER_RETRY))).rejects.toThrow(
      'synthetic queue outage',
    );
    expect(s.sender.acknowledgeRecoveryAutomation).not.toHaveBeenCalled();
  });
  it.each([Kind.FOLLOW_UP, Kind.ESCALATE_NO_REPLY])(
    'pauses %s while recovery is pending',
    async (kind) => {
      const s = setup();
      await s.processor.process(s.job(kind));
      expect(s.verifications.findById).not.toHaveBeenCalled();
      expect(s.hub.scheduleFollowUpAndEscalation).not.toHaveBeenCalled();
    },
  );
  it('recovery of a reminder reschedules escalation without another reminder', async () => {
    const s = setup();
    s.sender.resumeSenderRecovery.mockResolvedValue({
      status: 'sent',
      sentAt: '2026-11-03T12:00:00Z',
      recoveryKind: 'follow_up',
    });
    await s.processor.process(s.job(Kind.SENDER_RETRY));
    expect(s.hub.scheduleFollowUpAndEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ reminderAlreadySent: true }),
    );
  });
  it('sweeps durable work without loading a verification', async () => {
    const s = setup();
    await s.processor.process(s.job(Kind.SENDER_RECOVERY_SWEEP));
    expect(s.sender.sweepSenderRecovery).toHaveBeenCalled();
    expect(s.verifications.findById).not.toHaveBeenCalled();
  });
});

describe('sender recovery queue producer', () => {
  it('uses the persisted version and due time in delayed jobs', async () => {
    const queue = {
      getJob: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const producer = new VerificationAutomationProducer(queue as never);
    const dueAt = new Date(Date.now() + 30_000).toISOString();
    await producer.enqueueSenderRecovery({
      orgId: 'org',
      verificationId: 'verification',
      dispatchId: 'dispatch',
      action: 'retry',
      dueAt,
      version: 2,
    });
    expect(queue.add).toHaveBeenCalledWith(
      Kind.SENDER_RETRY,
      expect.objectContaining({ dispatchId: 'dispatch', scheduledAt: dueAt }),
      expect.objectContaining({
        jobId: 'sender-recovery-dispatch-2',
      }),
    );
    const options = queue.add.mock.calls[0] as unknown as [
      string,
      unknown,
      { delay: number },
    ];
    expect(options[2].delay).toBeGreaterThan(29_000);
  });
});
