import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  ChangeRequestReconfirmationService,
  reconfirmationFailureOf,
} from './change-request-reconfirmation.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */

const owner = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
} as unknown as AuthenticatedUser;
const viewer = { ...owner, role: 'viewer' } as unknown as AuthenticatedUser;

const job = {
  verificationId: 'ver-1',
  orgId: 'org-1',
  changeRequestId: 'cr-1',
  attempt: 2,
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cr-1',
    orgId: 'org-1',
    verificationId: 'ver-1',
    status: 'open',
    resolution: null,
    confirmationCycle: 1,
    reconfirmationAttempt: 2,
    reconfirmationState: 'requested',
    reconfirmationScheduledFor: null,
    lastReconfirmationError: null,
    ...overrides,
  };
}

const integration = {
  id: 'int-1',
  orgId: 'org-1',
  platformType: 'shopify',
  quietHoursEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: 'Africa/Cairo',
  isActive: true,
  accessToken: 'token',
};

const storedOrder = {
  id: 'order-1',
  orgId: 'org-1',
  integrationId: 'int-1',
  externalOrderId: '1001',
  isTest: false,
  customerPhone: '+201000000001',
  customerName: 'Mona',
  totalPrice: '500.00',
  currency: 'EGP',
  paymentMethod: 'Cash on Delivery (COD)',
  lineItems: [{ name: 'Mug', quantity: 1, unitPrice: '500.00' }],
  shippingRegion: 'Cairo',
  shippingAddress: '1 Old Street',
  integration,
};

const freshDetails = {
  customerPhone: '+201000000001',
  customerName: 'Mona',
  totalPrice: '750.00',
  currency: 'EGP',
  lineItems: [
    { name: 'Mug', quantity: 1, unitPrice: '500.00' },
    { name: 'Plate', quantity: 1, unitPrice: '250.00' },
  ],
  shippingRegion: 'Giza',
  shippingAddress: '9 New Street',
};

function setup(
  options: {
    requestRow?: Record<string, unknown> | null;
    afterSend?: Record<string, unknown> | null;
    requestResult?: unknown;
    inspection?: unknown;
    current?: unknown;
    sendOutcome?: unknown;
    integration?: Record<string, unknown>;
    sources?: unknown[];
    enqueueError?: Error;
  } = {},
) {
  const changeRequests = {
    requestReconfirmation: jest.fn().mockResolvedValue(
      options.requestResult ?? {
        outcome: 'requested',
        request: request({ reconfirmationAttempt: 2 }),
      },
    ),
    findById: jest
      .fn()
      .mockResolvedValueOnce(
        options.requestRow === undefined ? request() : options.requestRow,
      )
      .mockResolvedValue(
        options.afterSend === undefined
          ? request({ status: 'resolved', resolution: 'reconfirmation_sent' })
          : options.afterSend,
      ),
    findOpenForVerification: jest.fn(),
    markReconfirmationScheduled: jest.fn().mockResolvedValue(true),
    beginReconfirmationSend: jest
      .fn()
      .mockResolvedValue(request({ reconfirmationState: 'sending' })),
    recordReconfirmationFailure: jest.fn().mockResolvedValue('recorded'),
  };
  const verificationsRepo = {
    findByIdForOrg: jest
      .fn()
      .mockResolvedValue({ id: 'ver-1', orgId: 'org-1', orderId: 'order-1' }),
  };
  const order = {
    ...storedOrder,
    integration: { ...integration, ...options.integration },
  };
  const ordersRepo = {
    findById: jest.fn().mockResolvedValue(order),
    refreshCurrentDetails: jest.fn().mockResolvedValue({ id: 'order-1' }),
  };
  const sendService = {
    sendInitial: jest.fn().mockResolvedValue(
      options.sendOutcome ?? {
        status: 'sent',
        waMessageId: 'wamid.new',
        sentAt: '2026-11-08T10:00:00.000Z',
      },
    ),
  };
  const hub = { scheduleFollowUpAndEscalation: jest.fn() };
  const commerceOutcomes = {
    inspectForCancellation: jest
      .fn()
      .mockResolvedValue(options.inspection ?? { state: 'cancellable' }),
  };
  const automation = {
    enqueueReconfirmation: options.enqueueError
      ? jest.fn().mockRejectedValue(options.enqueueError)
      : jest.fn().mockResolvedValue(undefined),
    prepareRecoverySchedule: jest.fn(),
  };
  const source = {
    platform: 'shopify',
    readCurrentOrder: jest
      .fn()
      .mockResolvedValue(
        options.current ?? { status: 'found', order: freshDetails },
      ),
  };
  const service = new ChangeRequestReconfirmationService(
    changeRequests as any,
    verificationsRepo as any,
    ordersRepo as any,
    sendService as any,
    hub as any,
    commerceOutcomes as any,
    automation as any,
    (options.sources ?? [source]) as any,
  );
  return {
    service,
    changeRequests,
    ordersRepo,
    sendService,
    hub,
    commerceOutcomes,
    automation,
    source,
  };
}

describe('ChangeRequestReconfirmationService', () => {
  describe('request', () => {
    it('queues one attempt for the merchant', async () => {
      const { service, changeRequests, automation } = setup();
      await expect(
        service.request(owner, 'ver-1', {
          changeRequestId: 'cr-1',
          expectedCycle: 1,
        }),
      ).resolves.toEqual({
        changeRequestId: 'cr-1',
        state: 'requested',
        scheduledFor: null,
        lastError: null,
      });
      expect(changeRequests.requestReconfirmation).toHaveBeenCalledWith({
        orgId: 'org-1',
        verificationId: 'ver-1',
        changeRequestId: 'cr-1',
        expectedCycle: 1,
        actorUserId: 'user-1',
      });
      expect(automation.enqueueReconfirmation).toHaveBeenCalledWith({
        verificationId: 'ver-1',
        orgId: 'org-1',
        changeRequestId: 'cr-1',
        attempt: 2,
      });
    });

    it('joins an attempt already in flight instead of queueing a second send', async () => {
      const { service, automation } = setup({
        requestResult: {
          outcome: 'in_flight',
          request: request({ reconfirmationState: 'sending' }),
        },
      });
      await expect(
        service.request(owner, 'ver-1', {
          changeRequestId: 'cr-1',
          expectedCycle: 1,
        }),
      ).resolves.toMatchObject({ state: 'sending' });
      expect(automation.enqueueReconfirmation).not.toHaveBeenCalled();
    });

    it('refuses a viewer before touching the request', async () => {
      const { service, changeRequests } = setup();
      await expect(
        service.request(viewer, 'ver-1', {
          changeRequestId: 'cr-1',
          expectedCycle: 1,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(changeRequests.requestReconfirmation).not.toHaveBeenCalled();
    });

    it('reports a request the customer already settled with the outcome that won', async () => {
      const { service, automation } = setup({
        requestResult: {
          outcome: 'already_resolved',
          request: request({
            status: 'resolved',
            resolution: 'customer_confirmed',
          }),
          verificationStatus: 'confirmed',
        },
      });
      const error = await service
        .request(owner, 'ver-1', { changeRequestId: 'cr-1', expectedCycle: 1 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'CHANGE_REQUEST_ALREADY_RESOLVED',
        resolution: 'customer_confirmed',
        verificationStatus: 'confirmed',
      });
      expect(automation.enqueueReconfirmation).not.toHaveBeenCalled();
    });

    it('records the attempt as failed when it cannot be queued', async () => {
      const { service, changeRequests } = setup({
        enqueueError: new Error('redis down'),
      });
      await expect(
        service.request(owner, 'ver-1', {
          changeRequestId: 'cr-1',
          expectedCycle: 1,
        }),
      ).rejects.toMatchObject({
        response: { code: 'CHANGE_REQUEST_RECONFIRMATION_UNAVAILABLE' },
      });
      expect(changeRequests.recordReconfirmationFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'sending_unavailable', attempt: 2 }),
      );
    });
  });

  describe('run', () => {
    it('refreshes the order from its source, then sends it for the next cycle and starts the new timers', async () => {
      const { service, ordersRepo, sendService, hub, automation } = setup();
      await service.run(job);
      expect(ordersRepo.refreshCurrentDetails).toHaveBeenCalledWith(
        'order-1',
        'org-1',
        freshDetails,
      );
      expect(sendService.sendInitial).toHaveBeenCalledWith('ver-1', {
        confirmationCycle: 2,
      });
      expect(
        ordersRepo.refreshCurrentDetails.mock.invocationCallOrder[0],
      ).toBeLessThan(sendService.sendInitial.mock.invocationCallOrder[0]);
      expect(automation.prepareRecoverySchedule).toHaveBeenCalledWith({
        verificationId: 'ver-1',
        orgId: 'org-1',
      });
      expect(hub.scheduleFollowUpAndEscalation).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId: 'ver-1',
          baselineSentAt: new Date('2026-11-08T10:00:00.000Z'),
        }),
      );
    });

    it('gives the source the stored details, which a standalone order sends as they are', async () => {
      const { service, source } = setup();
      await service.run(job);
      expect(source.readCurrentOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          externalOrderId: '1001',
          stored: expect.objectContaining({
            totalPrice: '500.00',
            shippingAddress: '1 Old Street',
          }),
        }),
      );
    });

    it.each([
      [{ status: 'unavailable', code: 'order_source_unavailable' }],
      [{ status: 'unavailable', code: 'order_not_found' }],
    ])(
      'never sends stored details when the current ones cannot be read (%j)',
      async (current) => {
        const { service, ordersRepo, sendService, changeRequests, hub } = setup(
          { current },
        );
        await service.run(job);
        expect(ordersRepo.refreshCurrentDetails).not.toHaveBeenCalled();
        expect(sendService.sendInitial).not.toHaveBeenCalled();
        expect(hub.scheduleFollowUpAndEscalation).not.toHaveBeenCalled();
        expect(changeRequests.recordReconfirmationFailure).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: (current as { code: string }).code,
            attempt: 2,
          }),
        );
      },
    );

    it('fails when no source is registered for the platform', async () => {
      const { service, sendService, changeRequests } = setup({ sources: [] });
      await service.run(job);
      expect(sendService.sendInitial).not.toHaveBeenCalled();
      expect(changeRequests.recordReconfirmationFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'order_source_unavailable' }),
      );
    });

    it.each([
      [{ state: 'not_cancellable', reason: 'fulfilled' }, 'order_not_eligible'],
      [{ state: 'already_canceled' }, 'order_not_eligible'],
      [
        { state: 'not_cancellable', reason: 'order_not_found' },
        'order_not_found',
      ],
    ])(
      'does not confirm again an order the store shipped or canceled (%j)',
      async (inspection, reason) => {
        const { service, sendService, changeRequests } = setup({ inspection });
        await service.run(job);
        expect(sendService.sendInitial).not.toHaveBeenCalled();
        expect(changeRequests.recordReconfirmationFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason }),
        );
      },
    );

    it('waits for quiet hours to end, like any confirmation', async () => {
      const { service, changeRequests, automation, sendService } = setup({
        integration: {
          quietHoursEnabled: true,
          quietHoursStart: '00:00',
          quietHoursEnd: '23:59',
          timezone: 'UTC',
        },
      });
      await service.run(job);
      expect(sendService.sendInitial).not.toHaveBeenCalled();
      expect(changeRequests.beginReconfirmationSend).not.toHaveBeenCalled();
      expect(changeRequests.markReconfirmationScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 2,
          scheduledFor: expect.any(String),
        }),
      );
      expect(automation.enqueueReconfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 2, dueAt: expect.any(Date) }),
      );
    });

    it.each([
      [{ attempt: 1 }],
      [{ status: 'resolved', resolution: 'customer_confirmed' }],
      [{ reconfirmationState: 'sending' }],
      [{ reconfirmationState: 'failed' }],
    ])(
      'does nothing for an attempt that is no longer current (%j)',
      async (overrides) => {
        const { service, sendService } = setup({
          requestRow: request(
            'attempt' in overrides
              ? { reconfirmationAttempt: overrides.attempt }
              : overrides,
          ),
        });
        await service.run(job);
        expect(sendService.sendInitial).not.toHaveBeenCalled();
      },
    );

    it('sends nothing when another worker already took the attempt', async () => {
      const { service, changeRequests, sendService } = setup();
      changeRequests.beginReconfirmationSend.mockResolvedValue(null);
      await service.run(job);
      expect(sendService.sendInitial).not.toHaveBeenCalled();
    });

    it.each([
      [{ status: 'plan_limit_reached' }, 'no_allowance'],
      [{ status: 'skipped', reason: 'INSUFFICIENT_CREDITS' }, 'no_allowance'],
      [{ status: 'failed', reason: 'provider_not_accepted' }, 'sending_failed'],
      [{ status: 'outcome_unknown' }, 'provider_outcome_unknown'],
      [
        { status: 'skipped', reason: 'template_unavailable' },
        'template_unavailable',
      ],
    ])(
      'keeps the request open with no new timers when the send %j',
      async (sendOutcome, reason) => {
        const { service, changeRequests, hub } = setup({ sendOutcome });
        await service.run(job);
        expect(changeRequests.recordReconfirmationFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason, attempt: 2 }),
        );
        expect(hub.scheduleFollowUpAndEscalation).not.toHaveBeenCalled();
      },
    );

    it('leaves an own-number recovery in flight without recording anything', async () => {
      const { service, changeRequests, hub } = setup({
        sendOutcome: { status: 'recovery_pending' },
      });
      await service.run(job);
      expect(changeRequests.recordReconfirmationFailure).not.toHaveBeenCalled();
      expect(hub.scheduleFollowUpAndEscalation).not.toHaveBeenCalled();
    });

    it('does not start timers for a message whose cycle never started', async () => {
      const { service, hub, changeRequests } = setup({
        afterSend: request({
          status: 'resolved',
          resolution: 'customer_canceled',
        }),
      });
      await service.run(job);
      expect(hub.scheduleFollowUpAndEscalation).not.toHaveBeenCalled();
      expect(changeRequests.recordReconfirmationFailure).not.toHaveBeenCalled();
    });

    it('records an acceptance that could not be committed with its cycle', async () => {
      const { service, hub, changeRequests } = setup({
        afterSend: request({ reconfirmationState: 'sending' }),
      });
      await service.run(job);
      expect(hub.scheduleFollowUpAndEscalation).not.toHaveBeenCalled();
      expect(changeRequests.recordReconfirmationFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'provider_outcome_unknown' }),
      );
    });
  });

  describe('afterSenderRecovery', () => {
    it('records a failed own-number recovery of the updated confirmation', async () => {
      const { service, changeRequests } = setup();
      changeRequests.findOpenForVerification.mockResolvedValue(
        request({ reconfirmationState: 'sending' }),
      );
      await service.afterSenderRecovery('org-1', 'ver-1', {
        status: 'failed',
        reason: 'provider_not_accepted',
      });
      expect(changeRequests.recordReconfirmationFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'sending_failed', attempt: 2 }),
      );
    });

    it('ignores a recovery when no updated confirmation is sending', async () => {
      const { service, changeRequests } = setup();
      changeRequests.findOpenForVerification.mockResolvedValue(
        request({ reconfirmationState: null }),
      );
      await service.afterSenderRecovery('org-1', 'ver-1', { status: 'failed' });
      expect(changeRequests.recordReconfirmationFailure).not.toHaveBeenCalled();
    });
  });

  it('maps every send outcome to a stable failure code or none', () => {
    expect(reconfirmationFailureOf({ status: 'sent' })).toBeNull();
    expect(reconfirmationFailureOf({ status: 'recovery_pending' })).toBeNull();
    expect(
      reconfirmationFailureOf({
        status: 'skipped',
        reason: 'dispatch_in_progress',
      }),
    ).toBe('provider_outcome_unknown');
    expect(
      reconfirmationFailureOf({
        status: 'skipped',
        reason: 'billing_not_active',
      }),
    ).toBe('sending_unavailable');
  });
});
