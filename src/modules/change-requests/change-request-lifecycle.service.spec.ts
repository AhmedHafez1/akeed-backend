import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ChangeRequestLifecycleService } from './change-request-lifecycle.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

const owner = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
} as unknown as AuthenticatedUser;

const tapInput = {
  verificationId: 'ver-1',
  sourceProviderMessageId: 'wamid.confirmation',
  sender: { kind: 'akeed_system' as const },
  eventId: 'wamid.tap',
  occurredAt: '2026-11-07T10:00:00.000Z',
};

function setup(
  options: {
    inspection?: unknown;
    inspectionError?: Error;
    openRequest?: unknown;
    status?: string;
    isTest?: boolean;
    openResult?: unknown;
    merchantResult?: unknown;
  } = {},
) {
  const repo = {
    findOrderForVerification: jest.fn().mockResolvedValue({
      orgId: 'org-1',
      verificationStatus: options.status ?? 'delivered',
      integrationId: 'int-1',
      externalOrderId: '1001',
      isTest: options.isTest ?? false,
    }),
    findOpenForVerification: jest.fn().mockResolvedValue(options.openRequest),
    open: jest.fn().mockResolvedValue(
      options.openResult ?? {
        outcome: 'opened',
        request: { id: 'cr-1', orgId: 'org-1', verificationId: 'ver-1' },
        effects: [],
        stoppedAutoCancellation: false,
      },
    ),
    resolveByMerchantConfirmation: jest
      .fn()
      .mockResolvedValue(options.merchantResult),
  };
  const verificationsRepo = {
    removeMetadataKeys: jest.fn().mockResolvedValue([]),
    findByIdForOrg: jest.fn(),
  };
  const commerceOutcomes = {
    inspectForCancellation: options.inspectionError
      ? jest.fn().mockRejectedValue(options.inspectionError)
      : jest
          .fn()
          .mockResolvedValue(options.inspection ?? { state: 'cancellable' }),
  };
  const automation = {
    cancelPendingReminders: jest.fn().mockResolvedValue(2),
  };
  const service = new ChangeRequestLifecycleService(
    repo as any,
    verificationsRepo as any,
    commerceOutcomes as any,
    automation as any,
  );
  return { service, repo, verificationsRepo, commerceOutcomes, automation };
}

describe('ChangeRequestLifecycleService', () => {
  describe('openFromCustomer', () => {
    it('reads the store before opening and passes what it learned', async () => {
      const { service, repo, commerceOutcomes } = setup({
        inspection: { state: 'not_cancellable', reason: 'fulfilled' },
      });

      await service.openFromCustomer(tapInput);

      expect(commerceOutcomes.inspectForCancellation).toHaveBeenCalledWith({
        orgId: 'org-1',
        integrationId: 'int-1',
        externalOrderId: '1001',
        action: 'automatic_no_reply_cancellation',
        correlationId: 'ver-1',
      });
      expect(repo.open).toHaveBeenCalledWith({
        ...tapInput,
        shipping: 'shipped',
      });
    });

    it('treats an unreadable store as unknown, which does not block', async () => {
      const { service, repo } = setup({
        inspectionError: new Error('store timeout'),
      });

      await service.openFromCustomer(tapInput);

      expect(repo.open).toHaveBeenCalledWith(
        expect.objectContaining({ shipping: 'unknown' }),
      );
    });

    it('does not ask the store again for a repeat tap or a test order', async () => {
      const repeat = setup({ openRequest: { id: 'cr-1' } });
      await repeat.service.openFromCustomer(tapInput);
      expect(
        repeat.commerceOutcomes.inspectForCancellation,
      ).not.toHaveBeenCalled();

      const test = setup({ isTest: true });
      await test.service.openFromCustomer(tapInput);
      expect(
        test.commerceOutcomes.inspectForCancellation,
      ).not.toHaveBeenCalled();
    });

    it('removes the waiting reminder and escalation only after a new request', async () => {
      const opened = setup();
      await opened.service.openFromCustomer(tapInput);
      expect(opened.automation.cancelPendingReminders).toHaveBeenCalledWith({
        verificationId: 'ver-1',
        orgId: 'org-1',
      });
      expect(opened.verificationsRepo.removeMetadataKeys).toHaveBeenCalledWith(
        'ver-1',
        ['follow_up_due_at'],
      );

      const repeat = setup({
        openResult: { outcome: 'already_open', request: { id: 'cr-1' } },
      });
      await repeat.service.openFromCustomer(tapInput);
      expect(repeat.automation.cancelPendingReminders).not.toHaveBeenCalled();
    });

    it('keeps a committed request when removing the queued jobs fails', async () => {
      const { service, automation } = setup();
      automation.cancelPendingReminders.mockRejectedValue(
        new Error('redis unavailable'),
      );

      await expect(service.openFromCustomer(tapInput)).resolves.toMatchObject({
        outcome: 'opened',
      });
    });
  });

  describe('confirmAfterContact', () => {
    it('requires a role that may write', async () => {
      const { service, repo } = setup();
      await expect(
        service.confirmAfterContact(
          { ...owner, role: 'viewer' } as AuthenticatedUser,
          'ver-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.resolveByMerchantConfirmation).not.toHaveBeenCalled();
    });

    it('scopes the command to the merchant tenant and actor', async () => {
      const { service, repo } = setup({
        merchantResult: { outcome: 'resolved', request: {}, verification: {} },
      });
      await service.confirmAfterContact(owner, 'ver-1', 'cr-1');
      expect(repo.resolveByMerchantConfirmation).toHaveBeenCalledWith({
        orgId: 'org-1',
        verificationId: 'ver-1',
        changeRequestId: 'cr-1',
        actorUserId: 'user-1',
      });
    });

    it('tells the merchant the customer settled it first', async () => {
      const { service } = setup({
        merchantResult: {
          outcome: 'already_resolved',
          request: { resolution: 'customer_canceled' },
          verificationStatus: 'canceled',
        },
      });
      const error = await service
        .confirmAfterContact(owner, 'ver-1')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'CHANGE_REQUEST_ALREADY_RESOLVED',
        resolution: 'customer_canceled',
        verificationStatus: 'canceled',
      });
    });
  });
});
