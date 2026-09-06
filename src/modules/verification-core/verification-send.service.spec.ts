import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import { VerificationSendService } from './verification-send.service';

const baseIntegration = {
  platformType: 'shopify',
  id: 'int-1',
  orgId: 'org-1',
  isActive: true,
  billingStatus: 'active',
  storeName: 'Akeed Fashion',
  defaultLanguage: 'ar',
  codTemplateArVariant: 'gulf',
  codTemplateEnVariant: 'direct',
  billingPlanId: 'pro',
  billingActivatedAt: '2026-01-01T00:00:00Z',
  shopifySubscriptionId: 'sub-1',
};

function createMocks() {
  const verificationsRepo = {
    findById: jest.fn().mockResolvedValue({
      id: 'ver-1',
      orderId: 'order-1',
      orgId: 'org-1',
      status: 'pending',
      templateName: 'cod_verification',
    }),
    updateByIdForOrg: jest.fn(),
  };
  const ordersRepo = {
    findById: jest.fn().mockResolvedValue({
      integrationId: 'int-1',
      id: 'order-1',
      orgId: 'org-1',
      customerPhone: '+966500000000',
      customerName: 'Sara',
      externalOrderId: 'ext-1',
      totalPrice: '100.00',
      currency: 'SAR',
      integration: baseIntegration,
    }),
  };
  const billingEntitlementService = {
    evaluateAccess: (source: EntitlementSource, identity = source) =>
      resolveEntitlement(source, identity),
  };
  const messageDispatches = {
    claim: jest.fn().mockResolvedValue({
      outcome: 'claimed',
      dispatch: {
        id: 'dispatch-1',
        providerMessageId: null,
        acceptedAt: null,
      },
    }),
    // Resolves to the accepted ledger row. An `undefined` return means the
    // verification projection did not run, which the service must not report
    // as a successful send.
    markAccepted: jest
      .fn()
      .mockResolvedValue({ id: 'dispatch-1', state: 'accepted' }),
    markOutcomeUnknown: jest.fn().mockResolvedValue(undefined),
  };
  const messagingPort = {
    sendVerificationTemplate: jest
      .fn()
      .mockResolvedValue({ messages: [{ id: 'wamid-1' }] }),
  };
  const service = new VerificationSendService(
    verificationsRepo as never,
    ordersRepo as never,
    billingEntitlementService as never,
    messageDispatches as never,
    messagingPort as never,
  );
  return {
    service,
    verificationsRepo,
    ordersRepo,
    messageDispatches,
    messagingPort,
  };
}

describe('VerificationSendService', () => {
  it.each(['sendInitial', 'sendFollowUp'] as const)(
    'claims the logical %s dispatch before sending and persists acceptance',
    async (method) => {
      const { service, messageDispatches, messagingPort } = createMocks();

      await expect(service[method]('ver-1')).resolves.toEqual({
        status: 'sent',
        waMessageId: 'wamid-1',
        sentAt: expect.any(String) as string,
      });
      expect(messageDispatches.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId: 'ver-1',
          kind: method === 'sendInitial' ? 'initial' : 'follow_up',
        }),
      );
      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledTimes(1);
      expect(messageDispatches.markAccepted).toHaveBeenCalledWith({
        dispatchId: 'dispatch-1',
        providerMessageId: 'wamid-1',
        sentAt: expect.any(String) as string,
      });
    },
  );

  it('does not send again when the logical dispatch is already accepted', async () => {
    const { service, messageDispatches, messagingPort } = createMocks();
    messageDispatches.claim.mockResolvedValue({
      outcome: 'accepted',
      dispatch: {
        id: 'dispatch-1',
        providerMessageId: 'existing-wamid',
        acceptedAt: '2026-09-05T10:00:00.000Z',
      },
    });

    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'sent',
      waMessageId: 'existing-wamid',
      sentAt: '2026-09-05T10:00:00.000Z',
    });
    expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
    // Nothing new goes out, but the acceptance is re-projected: this is the
    // only moment that can pull a verification whose status lagged the ledger
    // back into agreement, which is what left rows reading `pending` after
    // their message had been delivered and read.
    expect(messageDispatches.markAccepted).toHaveBeenCalledWith({
      dispatchId: 'dispatch-1',
      providerMessageId: 'existing-wamid',
      sentAt: '2026-09-05T10:00:00.000Z',
    });
  });

  it('still reports the past send when repairing the projection fails', async () => {
    const { service, messageDispatches } = createMocks();
    messageDispatches.claim.mockResolvedValue({
      outcome: 'accepted',
      dispatch: {
        id: 'dispatch-1',
        providerMessageId: 'existing-wamid',
        acceptedAt: '2026-09-05T10:00:00.000Z',
      },
    });
    messageDispatches.markAccepted.mockRejectedValue(new Error('db down'));

    // The message really was accepted earlier; a failed repair must not
    // retroactively turn that into an error the caller acts on.
    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'sent',
      waMessageId: 'existing-wamid',
      sentAt: '2026-09-05T10:00:00.000Z',
    });
  });

  it('does not claim a send when acceptance could not be projected', async () => {
    const { service, messageDispatches, verificationsRepo } = createMocks();
    // `undefined` means the ledger row was in a state the acceptance could not
    // apply to, so the verification projection never ran. Reporting `sent` here
    // is what let a real send leave the row at `pending` with no wa_message_id
    // — which then also broke the delivery and read webhooks, since they
    // resolve against that id.
    messageDispatches.markAccepted.mockResolvedValue(undefined);

    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'outcome_unknown',
      reason: 'provider_outcome_unknown',
    });
    expect(messageDispatches.markOutcomeUnknown).toHaveBeenCalledWith(
      'dispatch-1',
      'acceptance_persistence_failed',
    );
    expect(verificationsRepo.updateByIdForOrg).toHaveBeenCalled();
  });

  it.each([
    ['provider exception', new Error('timeout')],
    ['missing provider message id', { messages: [] }],
  ])(
    'marks %s as unknown and retains its reservation',
    async (_label, result) => {
      const { service, messageDispatches, messagingPort, verificationsRepo } =
        createMocks();
      if (result instanceof Error) {
        messagingPort.sendVerificationTemplate.mockRejectedValue(result);
      } else {
        messagingPort.sendVerificationTemplate.mockResolvedValue(result);
      }

      await expect(service.sendInitial('ver-1')).resolves.toEqual({
        status: 'outcome_unknown',
        reason: 'provider_outcome_unknown',
      });
      expect(messageDispatches.markOutcomeUnknown).toHaveBeenCalledWith(
        'dispatch-1',
        expect.any(String),
      );
      expect(verificationsRepo.updateByIdForOrg).toHaveBeenCalledWith(
        'ver-1',
        'org-1',
        expect.objectContaining({
          status: 'failed',
          metadata: { reason: 'provider_outcome_unknown', kind: 'initial' },
        }),
      );
    },
  );

  it('does not retry an unknown or actively claimed dispatch', async () => {
    const { service, messageDispatches, messagingPort } = createMocks();
    messageDispatches.claim.mockResolvedValueOnce({
      outcome: 'outcome_unknown',
      dispatch: {},
    });
    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'outcome_unknown',
      reason: 'provider_outcome_unknown',
    });
    messageDispatches.claim.mockResolvedValueOnce({
      outcome: 'busy',
      dispatch: {},
    });
    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'dispatch_in_progress',
    });
    expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
  });

  it('returns a blocked lifecycle without sending when quota is exhausted', async () => {
    const { service, messageDispatches, messagingPort } = createMocks();
    messageDispatches.claim.mockResolvedValue({
      outcome: 'blocked',
      reason: 'plan_limit_reached',
      consumedCount: 1000,
      includedLimit: 1000,
    });

    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'plan_limit_reached',
      reason: 'plan_limit_reached',
    });
    expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null, 'missing_linked_integration'],
    [
      'wrong owner',
      { ...baseIntegration, orgId: 'org-2' },
      'source_identity_mismatch',
    ],
    [
      'inactive source',
      { ...baseIntegration, isActive: false },
      'integration_inactive',
    ],
  ])(
    'rejects a %s source before claiming or sending',
    async (_label, integration, reason) => {
      const { service, ordersRepo, messageDispatches, messagingPort } =
        createMocks();
      ordersRepo.findById.mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        integrationId: 'int-1',
        integration,
      });

      await expect(service.sendInitial('ver-1')).resolves.toEqual({
        status: 'skipped',
        reason,
      });
      expect(messageDispatches.claim).not.toHaveBeenCalled();
      expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
    },
  );
});
