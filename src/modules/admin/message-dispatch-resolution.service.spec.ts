import { ConflictException } from '@nestjs/common';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';

describe('MessageDispatchResolutionService', () => {
  function setup(state = 'outcome_unknown') {
    const dispatch = {
      id: 'dispatch-1',
      state,
      kind: 'initial',
      integrationId: 'int-1',
      verificationId: 'verification-1',
      providerMessageId: null as string | null,
      verification: {
        id: 'verification-1',
        orgId: 'org-1',
        order: {
          id: 'order-1',
          orgId: 'org-1',
          integration: { id: 'int-1', orgId: 'org-1' },
          webhookEvents: [
            {
              id: 'event-1',
              platform: 'standalone',
              jobType: 'order.create',
            },
          ],
        },
      },
    };
    const dispatches = {
      findById: jest.fn().mockResolvedValue(dispatch),
      markAccepted: jest.fn().mockResolvedValue({
        outcome: 'accepted',
        dispatch: { state: 'accepted' },
      }),
      resolveNotAccepted: jest.fn().mockResolvedValue({ state: 'rejected' }),
      isLatestGeneration: jest.fn().mockResolvedValue(true),
    };
    const events = {
      resetForRedispatch: jest.fn().mockResolvedValue({ id: 'event-1' }),
    };
    const webhookDispatcher = { dispatchById: jest.fn() };
    const verificationHub = { scheduleFollowUpAndEscalation: jest.fn() };
    const audit = { record: jest.fn() };
    const orders = {
      retryVerificationForOrg: jest
        .fn()
        .mockResolvedValue({ orderId: 'order-1', duplicate: false }),
    };
    const service = new MessageDispatchResolutionService(
      dispatches as never,
      events as never,
      webhookDispatcher as never,
      verificationHub as never,
      orders as never,
    );
    return {
      service,
      dispatch,
      dispatches,
      events,
      webhookDispatcher,
      verificationHub,
      audit,
      orders,
    };
  }

  it('accepts a verified provider id, projects sent state, and resumes automation', async () => {
    const { service, dispatches, verificationHub, audit } = setup();
    await expect(
      service.resolve('staff-1', 'dispatch-1', {
        resolution: 'accepted',
        providerMessageId: 'wamid-verified',
        reason: 'Confirmed in Meta delivery logs',
      }),
    ).resolves.toEqual({
      dispatchId: 'dispatch-1',
      state: 'accepted',
      duplicate: false,
    });
    expect(dispatches.markAccepted).toHaveBeenCalledWith({
      dispatchId: 'dispatch-1',
      providerMessageId: 'wamid-verified',
      sentAt: expect.any(String) as string,
      verificationId: 'verification-1',
      kind: 'initial',
      generation: undefined,
      staffAudit: {
        userId: 'staff-1',
        reason: 'Confirmed in Meta delivery logs',
      },
    });
    expect(verificationHub.scheduleFollowUpAndEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationId: 'verification-1',
        orgId: 'org-1',
      }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('releases a rejected outcome once and redispatches the durable event', async () => {
    const { service, dispatches, events, webhookDispatcher } = setup();
    await service.resolve('staff-1', 'dispatch-1', {
      resolution: 'not_accepted',
      reason: 'No matching message exists in provider logs',
    });
    expect(dispatches.resolveNotAccepted).toHaveBeenCalledWith('dispatch-1', {
      userId: 'staff-1',
      reason: 'No matching message exists in provider logs',
    });
    expect(events.resetForRedispatch).toHaveBeenCalledWith({
      id: 'event-1',
      orderId: 'order-1',
    });
    expect(webhookDispatcher.dispatchById).toHaveBeenCalledWith('event-1');
  });

  it('is idempotent for an identical decision and rejects a conflict', async () => {
    const accepted = setup('accepted');
    accepted.dispatch.providerMessageId = 'wamid-verified';
    await expect(
      accepted.service.resolve('staff-1', 'dispatch-1', {
        resolution: 'accepted',
        providerMessageId: 'wamid-verified',
        reason: 'Repeat reconciliation request',
      }),
    ).resolves.toMatchObject({ duplicate: true });
    expect(accepted.audit.record).not.toHaveBeenCalled();

    await expect(
      accepted.service.resolve('staff-1', 'dispatch-1', {
        resolution: 'not_accepted',
        reason: 'Conflicting reconciliation request',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  describe('resending a first confirmation that was not sent', () => {
    const input = { reason: 'Refused locally before the provider call' };

    it('resolves it not accepted as staff, then runs the merchant retry', async () => {
      const { service, dispatch, dispatches, orders, events } = setup();
      dispatch.verification.order.webhookEvents[0].platform = 'shopify';

      await expect(
        service.resendNotSent('staff-1', 'dispatch-1', input),
      ).resolves.toEqual({
        dispatchId: 'dispatch-1',
        state: 'rejected',
        retry: { orderId: 'order-1', duplicate: false },
      });
      expect(dispatches.resolveNotAccepted).toHaveBeenCalledWith('dispatch-1', {
        userId: 'staff-1',
        reason: input.reason,
      });
      expect(orders.retryVerificationForOrg).toHaveBeenCalledWith(
        'org-1',
        'order-1',
      );
      // The retry owns the redispatch; resolution does not start another.
      expect(events.resetForRedispatch).not.toHaveBeenCalled();
    });

    it('only retries a dispatch already resolved not accepted', async () => {
      const { service, dispatches, orders } = setup('rejected');

      await service.resendNotSent('staff-1', 'dispatch-1', input);

      expect(dispatches.resolveNotAccepted).not.toHaveBeenCalled();
      expect(orders.retryVerificationForOrg).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['has a provider message id', { providerMessageId: 'wamid-1' }],
      ['is a follow-up', { kind: 'follow_up' }],
      ['was accepted', { state: 'accepted' }],
      ['is still sending', { state: 'sending' }],
    ])(
      'refuses a dispatch that %s',
      async (_label, overrides: Record<string, unknown>) => {
        const { service, dispatch, dispatches, orders } = setup();
        Object.assign(dispatch, overrides);

        await expect(
          service.resendNotSent('staff-1', 'dispatch-1', input),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(dispatches.resolveNotAccepted).not.toHaveBeenCalled();
        expect(orders.retryVerificationForOrg).not.toHaveBeenCalled();
      },
    );

    it('does not retry when the dispatch could not be resolved', async () => {
      const { service, dispatches, orders } = setup();
      dispatches.resolveNotAccepted.mockResolvedValue(undefined);

      await expect(
        service.resendNotSent('staff-1', 'dispatch-1', input),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(orders.retryVerificationForOrg).not.toHaveBeenCalled();
    });
  });
});
