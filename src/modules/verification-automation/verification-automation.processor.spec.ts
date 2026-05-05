import { VerificationAutomationProcessor } from './verification-automation.processor';
import type { Job } from 'bullmq';
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
  isAutoVerifyEnabled: true,
  followUpEnabled: true,
  followUpDelayMinutes: 120,
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
