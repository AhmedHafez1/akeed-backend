import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { ChangeRequestMerchantService } from './change-request-merchant.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

const owner = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
} as unknown as AuthenticatedUser;
const viewer = { ...owner, role: 'viewer' } as unknown as AuthenticatedUser;

const openRequest = {
  id: 'cr-1',
  orgId: 'org-1',
  verificationId: 'ver-1',
  status: 'open',
  resolution: null,
  confirmationCycle: 1,
  openedAt: '2026-11-08T08:00:00.000Z',
  resolvedAt: null,
  reconfirmationState: 'failed',
  reconfirmationScheduledFor: null,
  lastReconfirmationError: 'no_allowance',
};

function setup(
  options: {
    verification?: unknown;
    dispatch?: unknown;
    recordError?: Error;
    autoCancelStatus?: string;
  } = {},
) {
  const changeRequests = {
    findByVerificationIds: jest.fn().mockResolvedValue([openRequest]),
    listHistory: jest.fn().mockResolvedValue([
      {
        event: 'opened',
        actorKind: 'customer',
        actorUserId: null,
        createdAt: '2026-11-08T08:00:00.000Z',
        detail: { phone: 'never shown' },
      },
      {
        event: 'reconfirmation_failed',
        actorKind: 'system',
        actorUserId: null,
        createdAt: '2026-11-08T09:00:00.000Z',
        detail: { reason: 'no_allowance', attempt: 1 },
      },
    ]),
    listEffects: jest.fn().mockResolvedValue([
      {
        kind: 'customer_acknowledgment',
        status: 'skipped',
        reason: 'skipped_no_allowance',
      },
      { kind: 'merchant_email', status: 'pending', reason: null },
    ]),
  };
  const lifecycle = {
    confirmAfterContact: jest
      .fn()
      .mockResolvedValue({ outcome: 'resolved', request: openRequest }),
    assertMerchantActionable: jest.fn().mockResolvedValue(openRequest),
    recordCancellationAfterContact: options.recordError
      ? jest.fn().mockRejectedValue(options.recordError)
      : jest
          .fn()
          .mockResolvedValue({ outcome: 'resolved', request: openRequest }),
  };
  const reconfirmations = { request: jest.fn() };
  const hub = { finalizeVerification: jest.fn() };
  const commerceOutcomes = {
    dispatch: jest
      .fn()
      .mockResolvedValueOnce(options.dispatch ?? { status: 'applied' })
      .mockResolvedValue({ status: 'applied' }),
  };
  const verificationsRepo = {
    findByIdForOrg: jest
      .fn()
      .mockResolvedValue(
        options.verification === undefined
          ? { id: 'ver-1', orgId: 'org-1', orderId: 'order-1' }
          : options.verification,
      ),
  };
  const ordersRepo = {
    findById: jest.fn().mockResolvedValue({
      id: 'order-1',
      orgId: 'org-1',
      integrationId: 'int-1',
      externalOrderId: '1001',
      integration: { id: 'int-1', orgId: 'org-1' },
    }),
  };
  const autoCancellations = {
    findByVerification: jest
      .fn()
      .mockResolvedValue(
        options.autoCancelStatus ? { status: options.autoCancelStatus } : null,
      ),
  };
  const service = new ChangeRequestMerchantService(
    changeRequests as any,
    lifecycle as any,
    reconfirmations as any,
    hub as any,
    commerceOutcomes as any,
    verificationsRepo as any,
    ordersRepo as any,
    autoCancellations as any,
  );
  return {
    service,
    changeRequests,
    lifecycle,
    reconfirmations,
    hub,
    commerceOutcomes,
    verificationsRepo,
  };
}

describe('ChangeRequestMerchantService', () => {
  describe('get', () => {
    it('shows the request, its acknowledgment outcome and its history without customer data', async () => {
      const { service } = setup();
      const { change_request } = await service.get(owner, 'ver-1');
      expect(change_request).toMatchObject({
        id: 'cr-1',
        status: 'open',
        acknowledgment: { status: 'skipped', reason: 'skipped_no_allowance' },
        reconfirmation: { state: 'failed', last_error: 'no_allowance' },
      });
      expect(change_request?.history[0].detail).toEqual({});
      expect(change_request?.history[1].detail).toEqual({
        reason: 'no_allowance',
        attempt: 1,
      });
    });

    it('reads another tenant’s order as not found', async () => {
      const { service, changeRequests } = setup({ verification: null });
      await expect(service.get(owner, 'ver-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(changeRequests.findByVerificationIds).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('closes the request with the merchant as actor, then syncs like a manual confirmation', async () => {
      const { service, lifecycle, hub } = setup();
      await expect(service.confirm(owner, 'ver-1', 'cr-1')).resolves.toEqual({
        success: true,
        verificationId: 'ver-1',
        status: 'confirmed',
        changeRequestId: 'cr-1',
      });
      expect(lifecycle.confirmAfterContact).toHaveBeenCalledWith(
        owner,
        'ver-1',
        'cr-1',
      );
      expect(hub.finalizeVerification).toHaveBeenCalledWith(
        'ver-1',
        'confirmed',
      );
    });

    it('does not sync when the customer already settled the request', async () => {
      const { service, lifecycle, hub } = setup();
      lifecycle.confirmAfterContact.mockRejectedValue(
        new ConflictException({ code: 'CHANGE_REQUEST_ALREADY_RESOLVED' }),
      );
      await expect(
        service.confirm(owner, 'ver-1', 'cr-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(hub.finalizeVerification).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('cancels in the store, then records the outcome and tags the order', async () => {
      const { service, commerceOutcomes, lifecycle } = setup();
      await expect(service.cancel(owner, 'ver-1', 'cr-1')).resolves.toEqual({
        success: true,
        verificationId: 'ver-1',
        status: 'canceled',
        changeRequestId: 'cr-1',
        operation: { status: 'applied' },
      });
      expect(
        commerceOutcomes.dispatch.mock.calls.map(
          ([command]) => (command as { action: string }).action,
        ),
      ).toEqual([
        'merchant_no_reply_cancellation',
        'merchant_cancellation_tagging',
      ]);
      expect(lifecycle.recordCancellationAfterContact).toHaveBeenCalledWith(
        owner,
        'ver-1',
        { status: 'applied' },
        'cr-1',
      );
    });

    it('refuses a viewer before the store is asked', async () => {
      const { service, commerceOutcomes } = setup();
      await expect(
        service.cancel(viewer, 'ver-1', 'cr-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a page that showed an older request', async () => {
      const { service, commerceOutcomes } = setup();
      await expect(
        service.cancel(owner, 'ver-1', 'cr-old'),
      ).rejects.toMatchObject({ response: { code: 'CHANGE_REQUEST_STALE' } });
      expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
    });

    it('does not cancel twice while the automatic cancellation is at the store', async () => {
      const { service, commerceOutcomes } = setup({
        autoCancelStatus: 'in_progress',
      });
      await expect(
        service.cancel(owner, 'ver-1', 'cr-1'),
      ).rejects.toMatchObject({
        response: { code: 'AUTO_CANCEL_ALREADY_IN_PROGRESS' },
      });
      expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
    });

    it('records nothing when the store refuses', async () => {
      const { service, lifecycle } = setup({
        dispatch: { status: 'retryable_failure', errorCode: 'store_down' },
      });
      await expect(
        service.cancel(owner, 'ver-1', 'cr-1'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(lifecycle.recordCancellationAfterContact).not.toHaveBeenCalled();
    });

    it('reports a customer answer that won after the store accepted, without tagging', async () => {
      const { service, commerceOutcomes } = setup({
        recordError: new ConflictException({
          code: 'CHANGE_REQUEST_ALREADY_RESOLVED',
        }),
      });
      await expect(
        service.cancel(owner, 'ver-1', 'cr-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(commerceOutcomes.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it('passes a resend to the reconfirmation service as asked', async () => {
    const { service, reconfirmations } = setup();
    await service.resend(owner, 'ver-1', {
      changeRequestId: 'cr-1',
      expectedCycle: 1,
    });
    expect(reconfirmations.request).toHaveBeenCalledWith(owner, 'ver-1', {
      changeRequestId: 'cr-1',
      expectedCycle: 1,
    });
  });
});
