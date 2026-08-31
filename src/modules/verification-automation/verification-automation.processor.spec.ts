import { VerificationAutomationProcessor } from './verification-automation.processor';
import type { Job } from 'bullmq';
import { DelayedError } from 'bullmq';
import {
  VerificationAutomationJobPayload,
  VerificationAutomationJobType,
} from './verification-automation.constants';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

function createMocks() {
  const verificationsRepo = {
    findById: jest.fn(),
    updateStatus: jest.fn(),
    updateByIdForOrg: jest.fn(),
    markFollowUpSent: jest.fn(),
    mergeMetadata: jest.fn(),
  };
  const ordersRepo = {
    findById: jest.fn(),
  };
  const verificationSendService = {
    sendInitial: jest.fn(),
    sendFollowUp: jest.fn(),
  };
  const verificationHub = {
    scheduleFollowUpAndEscalation: jest.fn(),
  };
  const orderTaggingPort = {
    addOrderTag: jest.fn(),
  };

  const processor = new VerificationAutomationProcessor(
    verificationsRepo as any,
    ordersRepo as any,
    verificationSendService as any,
    verificationHub as any,
    orderTaggingPort as any,
  );

  return {
    processor,
    verificationsRepo,
    ordersRepo,
    verificationSendService,
    verificationHub,
    orderTaggingPort,
  };
}

const baseIntegration = {
  id: 'int-1',
  orgId: 'org-1',
  isActive: true,
  billingStatus: 'active',
  isAutoVerifyEnabled: true,
  followUpEnabled: true,
  followUpDelayMinutes: 120,
  escalationEnabled: true,
  escalationDelayMinutes: 360,
  quietHoursEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: 'Asia/Riyadh',
  platformStoreUrl: 'test.myshopify.com',
  defaultLanguage: 'ar',
};

function buildJob(
  name: VerificationAutomationJobType,
  verificationId = 'ver-1',
  orgId = 'org-1',
): Job<VerificationAutomationJobPayload> & { moveToDelayed: jest.Mock } {
  return {
    id: `job-${name}`,
    name,
    data: {
      verificationId,
      orgId,
      scheduledAt: new Date().toISOString(),
    },
    moveToDelayed: jest.fn(),
  } as unknown as Job<VerificationAutomationJobPayload> & {
    moveToDelayed: jest.Mock;
  };
}

describe('VerificationAutomationProcessor', () => {
  describe('remaining E01 boundaries', () => {
    afterEach(() => jest.useRealTimers());
    function setup(status = 'sent', integration: Record<string, unknown> = {}) {
      const mocks = createMocks();
      const verification = {
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status,
        followUpAttempts: 0,
        merchantCanceledAt: null,
      };
      mocks.verificationsRepo.findById.mockResolvedValue(verification);
      mocks.ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: { ...baseIntegration, ...integration },
      });
      return { ...mocks, verification };
    }

    it('does not send a second initial message when a completed send job is retried', async () => {
      const {
        processor,
        verificationsRepo,
        verificationSendService,
        verificationHub,
      } = setup();
      await processor.process(
        buildJob(VerificationAutomationJobType.INITIAL_SEND),
      );
      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
      expect(
        verificationHub.scheduleFollowUpAndEscalation,
      ).not.toHaveBeenCalled();
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
    });

    it.each(['confirmed', 'canceled', 'failed', 'expired', 'no_reply'])(
      'blocks follow-up and escalation for %s',
      async (status) => {
        const {
          processor,
          verificationSendService,
          verificationsRepo,
          orderTaggingPort,
        } = setup(status);
        await processor.process(
          buildJob(VerificationAutomationJobType.FOLLOW_UP),
        );
        await processor.process(
          buildJob(VerificationAutomationJobType.ESCALATE_NO_REPLY),
        );
        expect(verificationSendService.sendFollowUp).not.toHaveBeenCalled();
        expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
        expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
      },
    );

    it.each([
      VerificationAutomationJobType.INITIAL_SEND,
      VerificationAutomationJobType.FOLLOW_UP,
      VerificationAutomationJobType.ESCALATE_NO_REPLY,
    ])(
      'reschedules %s during quiet hours using the lock token',
      async (kind) => {
        jest
          .useFakeTimers()
          .setSystemTime(new Date('2026-05-01T03:00:00.000Z'));
        const {
          processor,
          verificationSendService,
          verificationsRepo,
          orderTaggingPort,
        } = setup(
          kind === VerificationAutomationJobType.INITIAL_SEND
            ? 'pending'
            : 'sent',
          {
            quietHoursEnabled: true,
            quietHoursStart: '21:00',
            quietHoursEnd: '09:00',
            timezone: 'Asia/Riyadh',
          },
        );
        const job = buildJob(kind);
        await expect(
          processor.process(job, 'synthetic-lock-token'),
        ).rejects.toBeInstanceOf(DelayedError);
        expect(job.moveToDelayed).toHaveBeenCalledWith(
          new Date('2026-05-01T06:00:00.000Z').getTime(),
          'synthetic-lock-token',
        );
        expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
        expect(verificationSendService.sendFollowUp).not.toHaveBeenCalled();
        expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
        expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
      },
    );

    it.each(['send_error', 'missing_wamid'])(
      'records follow-up %s metadata without replacing the original message or status',
      async (reason) => {
        const { processor, verificationSendService, verificationsRepo } =
          setup();
        verificationSendService.sendFollowUp.mockResolvedValue({
          status: 'failed',
          reason,
        });
        await processor.process(
          buildJob(VerificationAutomationJobType.FOLLOW_UP),
        );
        expect(verificationsRepo.mergeMetadata).toHaveBeenCalledWith(
          'ver-1',
          expect.objectContaining({ follow_up_failed: reason }),
        );
        expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
        expect(verificationsRepo.markFollowUpSent).not.toHaveBeenCalled();
      },
    );

    it('marks synthetic no-reply orders locally without provider tagging', async () => {
      const {
        processor,
        ordersRepo,
        verificationsRepo,
        orderTaggingPort,
        verification,
      } = setup();
      verification.followUpAttempts = 1;
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'akeed-test-123',
        integration: baseIntegration,
      });
      await processor.process(
        buildJob(VerificationAutomationJobType.ESCALATE_NO_REPLY),
      );
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        'no_reply',
        undefined,
        undefined,
      );
      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });

    it('keeps no-reply status when provider tagging fails', async () => {
      const { processor, orderTaggingPort, verificationsRepo, verification } =
        setup();
      verification.followUpAttempts = 1;
      orderTaggingPort.addOrderTag.mockRejectedValue(
        new Error('provider tagging failed'),
      );
      await expect(
        processor.process(
          buildJob(VerificationAutomationJobType.ESCALATE_NO_REPLY),
        ),
      ).resolves.toBeUndefined();
      expect(verificationsRepo.updateStatus).toHaveBeenCalledTimes(1);
      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        'no_reply',
        undefined,
        undefined,
      );
      expect(orderTaggingPort.addOrderTag).toHaveBeenCalledTimes(1);
    });

    it('US-06-02: accepted follow-up with failed message persistence can be sent again on retry', async () => {
      const { processor, verificationSendService, verificationsRepo } = setup();
      verificationSendService.sendFollowUp.mockResolvedValue({
        status: 'sent',
        waMessageId: 'accepted-follow-up',
      });
      verificationsRepo.markFollowUpSent.mockRejectedValueOnce(
        new Error('write failed'),
      );
      const job = buildJob(VerificationAutomationJobType.FOLLOW_UP);
      await expect(processor.process(job)).rejects.toThrow('write failed');
      await processor.process(job);
      expect(verificationSendService.sendFollowUp).toHaveBeenCalledTimes(2);
      expect(verificationsRepo.markFollowUpSent).toHaveBeenCalledTimes(2);
    });
  });
  describe('integration eligibility', () => {
    it.each([
      VerificationAutomationJobType.INITIAL_SEND,
      VerificationAutomationJobType.FOLLOW_UP,
      VerificationAutomationJobType.ESCALATE_NO_REPLY,
    ])('skips %s after uninstall without outbound work', async (jobType) => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
        verificationHub,
        orderTaggingPort,
      } = createMocks();
      const isInitial = jobType === VerificationAutomationJobType.INITIAL_SEND;
      const isEscalation =
        jobType === VerificationAutomationJobType.ESCALATE_NO_REPLY;

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: isInitial ? 'pending' : 'sent',
        followUpAttempts: isEscalation ? 1 : 0,
        merchantCanceledAt: null,
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-1',
        integration: { ...baseIntegration, isActive: false },
      });

      const job = buildJob(jobType);
      await processor.process(job);

      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
      expect(verificationSendService.sendFollowUp).not.toHaveBeenCalled();
      expect(
        verificationHub.scheduleFollowUpAndEscalation,
      ).not.toHaveBeenCalled();
      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
      expect(job.moveToDelayed).not.toHaveBeenCalled();

      if (isInitial) {
        expect(verificationsRepo.updateByIdForOrg).toHaveBeenCalledWith(
          'ver-1',
          'org-1',
          expect.objectContaining({
            status: 'failed',
            metadata: expect.objectContaining({
              reason: 'integration_inactive',
            }) as Record<string, unknown>,
          }),
        );
      } else {
        expect(verificationsRepo.mergeMetadata).toHaveBeenCalledWith(
          'ver-1',
          expect.objectContaining({
            [isEscalation ? 'escalation_skipped' : 'follow_up_skipped']:
              'integration_inactive',
          }),
        );
      }
    });

    it('blocks delayed work when billing is inactive but installation remains active', async () => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'pending',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-1',
        integration: {
          ...baseIntegration,
          isActive: true,
          billingStatus: 'cancelled',
        },
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.INITIAL_SEND),
      );

      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
      expect(verificationsRepo.updateByIdForOrg).toHaveBeenCalledWith(
        'ver-1',
        'org-1',
        expect.objectContaining({
          status: 'failed',
          metadata: expect.objectContaining({
            reason: 'billing_not_active',
          }) as Record<string, unknown>,
        }),
      );
    });
  });

  describe('FOLLOW_UP', () => {
    it('skips when follow-up disabled', async () => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'sent',
        followUpAttempts: 0,
        merchantCanceledAt: null,
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        externalOrderId: 'ext-1',
        integration: { ...baseIntegration, followUpEnabled: false },
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.FOLLOW_UP),
      );

      expect(verificationSendService.sendFollowUp).not.toHaveBeenCalled();
    });

    it('skips when verification status is terminal (confirmed)', async () => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'confirmed',
        followUpAttempts: 0,
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: baseIntegration,
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.FOLLOW_UP),
      );

      expect(verificationSendService.sendFollowUp).not.toHaveBeenCalled();
    });

    it('marks plan-limit metadata when send service reports plan limit', async () => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'sent',
        followUpAttempts: 0,
        merchantCanceledAt: null,
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: baseIntegration,
      });
      verificationSendService.sendFollowUp.mockResolvedValue({
        status: 'plan_limit_reached',
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.FOLLOW_UP),
      );

      expect(verificationsRepo.mergeMetadata).toHaveBeenCalledWith(
        'ver-1',
        expect.objectContaining({ follow_up_skipped: 'plan_limit_reached' }),
      );
      expect(verificationsRepo.markFollowUpSent).not.toHaveBeenCalled();
    });

    it('records follow-up sent on success', async () => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'sent',
        followUpAttempts: 0,
        merchantCanceledAt: null,
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: baseIntegration,
      });
      verificationSendService.sendFollowUp.mockResolvedValue({
        status: 'sent',
        waMessageId: 'wamid-2',
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.FOLLOW_UP),
      );

      expect(verificationsRepo.markFollowUpSent).toHaveBeenCalledWith(
        'ver-1',
        'wamid-2',
      );
    });

    it('processes now instead of silently completing when quiet-hours token is unavailable', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-05-01T03:00:00.000Z'));

      try {
        const {
          processor,
          verificationsRepo,
          ordersRepo,
          verificationSendService,
        } = createMocks();

        verificationsRepo.findById.mockResolvedValue({
          id: 'ver-1',
          orderId: 'order-1',
          orgId: 'org-1',
          status: 'sent',
          followUpAttempts: 0,
          merchantCanceledAt: null,
        });
        ordersRepo.findById.mockResolvedValue({
          id: 'order-1',
          externalOrderId: 'ext-1',
          integration: {
            ...baseIntegration,
            quietHoursEnabled: true,
            quietHoursStart: '21:00',
            quietHoursEnd: '09:00',
            timezone: 'Asia/Riyadh',
          },
        });
        verificationSendService.sendFollowUp.mockResolvedValue({
          status: 'sent',
          waMessageId: 'wamid-2',
        });

        const job = buildJob(VerificationAutomationJobType.FOLLOW_UP);
        await processor.process(job);

        expect(job.moveToDelayed).not.toHaveBeenCalled();
        expect(verificationSendService.sendFollowUp).toHaveBeenCalledWith(
          'ver-1',
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('ESCALATE_NO_REPLY', () => {
    it('marks no_reply and tags Shopify order', async () => {
      const { processor, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'sent',
        followUpAttempts: 1,
        merchantCanceledAt: null,
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: baseIntegration,
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.ESCALATE_NO_REPLY),
      );

      expect(verificationsRepo.updateStatus).toHaveBeenCalledWith(
        'ver-1',
        'no_reply',
        undefined,
        undefined,
      );
      expect(orderTaggingPort.addOrderTag).toHaveBeenCalledWith(
        baseIntegration,
        'ext-1',
        'Akeed: No Reply',
      );
    });

    it('skips when status already terminal', async () => {
      const { processor, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'confirmed',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: baseIntegration,
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.ESCALATE_NO_REPLY),
      );

      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });

    it('skips when merchant canceled', async () => {
      const { processor, verificationsRepo, ordersRepo, orderTaggingPort } =
        createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'sent',
        merchantCanceledAt: '2026-05-01T10:00:00Z',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: baseIntegration,
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.ESCALATE_NO_REPLY),
      );

      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
      expect(orderTaggingPort.addOrderTag).not.toHaveBeenCalled();
    });
  });

  describe('INITIAL_SEND', () => {
    it('skips when auto-verify disabled at execution time', async () => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'pending',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: { ...baseIntegration, isAutoVerifyEnabled: false },
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.INITIAL_SEND),
      );

      expect(verificationSendService.sendInitial).not.toHaveBeenCalled();
      expect(verificationsRepo.mergeMetadata).toHaveBeenCalledWith(
        'ver-1',
        expect.objectContaining({
          initial_send_skipped: 'auto_verify_disabled',
        }),
      );
    });

    it('sends and schedules follow-up + no-reply on success', async () => {
      const {
        processor,
        verificationsRepo,
        ordersRepo,
        verificationSendService,
        verificationHub,
      } = createMocks();

      verificationsRepo.findById.mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'pending',
      });
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'ext-1',
        integration: baseIntegration,
      });
      verificationSendService.sendInitial.mockResolvedValue({
        status: 'sent',
        waMessageId: 'wamid-1',
      });

      await processor.process(
        buildJob(VerificationAutomationJobType.INITIAL_SEND),
      );

      expect(verificationSendService.sendInitial).toHaveBeenCalledWith('ver-1');
      expect(verificationHub.scheduleFollowUpAndEscalation).toHaveBeenCalled();
    });
  });
});
