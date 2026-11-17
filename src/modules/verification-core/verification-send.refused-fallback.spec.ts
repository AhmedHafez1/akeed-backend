import { VerificationSendService } from './verification-send.service';

/**
 * A fallback is an ordinary Akeed-number send. When no Akeed message or
 * credits are left it is refused, and the order waits as a blocked order.
 */
describe('VerificationSendService refused fallback', () => {
  function setup(
    sendResult: { status: string; reason?: string },
    kind = 'initial',
  ) {
    const dispatch = {
      id: 'dispatch',
      orgId: 'org',
      verificationId: 'verification',
      kind,
      senderRecoveryState: 'fallback',
      senderRecoveryDueAt: new Date(Date.now() - 1_000).toISOString(),
      senderRecoveryVersion: 3,
      senderAutomationPending: false,
      metadata: {},
    };
    const messageDispatches = {
      findSenderRecovery: jest.fn().mockResolvedValue(dispatch),
      finishSenderRecovery: jest.fn().mockResolvedValue(undefined),
      endRefusedFallback: jest.fn().mockResolvedValue(true),
      acknowledgeRecoveryAutomation: jest.fn().mockResolvedValue(undefined),
    };
    const service = new VerificationSendService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      messageDispatches as never,
      {} as never,
      {} as never,
    );
    const internals = service as unknown as {
      loadContext: jest.Mock;
      sendOnce: jest.Mock;
    };
    internals.loadContext = jest.fn().mockResolvedValue({
      context: {
        verification: { id: 'verification', orgId: 'org', status: 'sending' },
        order: { createdAt: new Date().toISOString() },
        integration: { id: 'integration' },
        billingExempt: false,
      },
    });
    internals.sendOnce = jest.fn().mockResolvedValue(sendResult);
    return { service, messageDispatches, sendOnce: internals.sendOnce };
  }

  it.each([
    [
      { status: 'plan_limit_reached', reason: 'plan_limit_reached' },
      'plan_limit_reached',
    ],
    [
      { status: 'skipped', reason: 'INSUFFICIENT_CREDITS' },
      'INSUFFICIENT_CREDITS',
    ],
    [
      { status: 'skipped', reason: 'CREDIT_DEBT_OUTSTANDING' },
      'CREDIT_DEBT_OUTSTANDING',
    ],
  ])(
    'ends a fallback refused with %o as a blocked order',
    async (result, reason) => {
      const s = setup(result);
      const outcome = await s.service.resumeSenderRecovery('org', 'dispatch');
      expect(s.sendOnce).toHaveBeenCalledTimes(1);
      expect(s.messageDispatches.endRefusedFallback).toHaveBeenCalledWith(
        'org',
        'dispatch',
        reason,
      );
      expect(s.messageDispatches.finishSenderRecovery).not.toHaveBeenCalled();
      // The hub maps this outcome to the same blocked order.
      expect(outcome).toEqual({ ...result, recoveryKind: 'initial' });
    },
  );

  it('ends a refused reminder fallback the same way', async () => {
    const s = setup({ status: 'plan_limit_reached' }, 'follow_up');
    await s.service.resumeSenderRecovery('org', 'dispatch');
    expect(s.messageDispatches.endRefusedFallback).toHaveBeenCalledWith(
      'org',
      'dispatch',
      'plan_limit_reached',
    );
  });

  it.each([
    [{ status: 'sent' }, true],
    [{ status: 'failed', reason: 'provider_not_accepted' }, false],
    [{ status: 'skipped', reason: 'template_unavailable' }, false],
  ])('finishes any other result %o as before', async (result, sent) => {
    const s = setup(result);
    await s.service.resumeSenderRecovery('org', 'dispatch');
    expect(s.messageDispatches.endRefusedFallback).not.toHaveBeenCalled();
    expect(s.messageDispatches.finishSenderRecovery).toHaveBeenCalledWith(
      'org',
      'dispatch',
      false,
      sent,
    );
  });
});
