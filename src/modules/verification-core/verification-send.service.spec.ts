import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import type { DispatchAcceptanceResult } from '../../infrastructure/database/repositories/verification-message-dispatches.repository';
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
  const order = {
    integrationId: 'int-1',
    id: 'order-1',
    orgId: 'org-1',
    customerPhone: '+966500000000',
    customerName: 'Sara',
    externalOrderId: 'ext-1',
    orderNumber: '1117' as string | null | undefined,
    totalPrice: '100.00',
    currency: 'SAR',
    integration: baseIntegration,
  };
  const ordersRepo = {
    findById: jest.fn().mockResolvedValue(order),
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
    // Discriminated on purpose: anything other than `accepted` tells the
    // service the ledger could not record the acceptance, and which of the
    // causes fired.
    markAccepted: jest.fn().mockResolvedValue({
      outcome: 'accepted',
      dispatch: { id: 'dispatch-1', state: 'accepted' },
    }),
    markOutcomeUnknown: jest.fn().mockResolvedValue(1),
    markFailedProviderOutcome: jest.fn().mockResolvedValue(1),
    projectAcceptanceWithoutLedger: jest.fn().mockResolvedValue(1),
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
    { resolveDenial: jest.fn().mockResolvedValue(null) } as never,
    messageDispatches as never,
    messagingPort as never,
  );
  return {
    service,
    order,
    verificationsRepo,
    ordersRepo,
    messageDispatches,
    messagingPort,
  };
}

describe('VerificationSendService', () => {
  // The customer reads this value. `externalOrderId` is a dedupe key -- a raw
  // Shopify order id, or the `manual-<hash>` synthesised from an idempotency
  // key -- so sending it named something the customer has never seen.
  const orderReferences: [string, string | null | undefined, string][] = [
    ['the merchant-facing number when present', '1117', '1117'],
    ['the source id when the number is blank', '   ', 'ext-1'],
    ['the source id when the number is null', null, 'ext-1'],
    ['the source id when the number is absent', undefined, 'ext-1'],
  ];

  it.each(orderReferences)(
    'sends %s',
    async (_label, orderNumber, expected) => {
      const { service, order, ordersRepo, messagingPort } = createMocks();
      ordersRepo.findById.mockResolvedValue({ ...order, orderNumber });

      await service.sendInitial('ver-1');

      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ orderNumber: expected }),
      );
    },
  );

  it('reports an untracked send when nothing could record the acceptance', async () => {
    const { service, messageDispatches, verificationsRepo } = createMocks();
    messageDispatches.markAccepted.mockResolvedValue({
      outcome: 'verification_missing',
    });
    // Both salvage writes are row-guarded, so both legitimately match nothing
    // once the verification is gone -- and its cascade takes the dispatch with
    // it. Reporting `sent` here is what let the caller schedule follow-up and
    // escalation work against a row that no longer existed.
    messageDispatches.markOutcomeUnknown.mockResolvedValue(0);
    messageDispatches.projectAcceptanceWithoutLedger.mockResolvedValue(0);
    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'sent_untracked',
      reason: 'send_not_recorded',
      waMessageId: 'wamid-1',
      sentAt: expect.any(String) as string,
    });
    // The customer was messaged, so nothing may stamp the send as a failure.
    expect(verificationsRepo.updateByIdForOrg).not.toHaveBeenCalled();
  });

  it('still reports a plain send when a terminal row simply refuses the projection', async () => {
    const { service, messageDispatches } = createMocks();
    messageDispatches.markAccepted.mockResolvedValue({ outcome: 'not_found' });
    messageDispatches.projectAcceptanceWithoutLedger.mockResolvedValue(0);

    // A follow-up projection is terminal-guarded on purpose, so zero rows on a
    // verification that still exists is expected, not an orphaned send.
    await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
      status: 'sent',
      waMessageId: 'wamid-1',
    });
  });

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
        verificationId: 'ver-1',
        kind: method === 'sendInitial' ? 'initial' : 'follow_up',
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
      verificationId: 'ver-1',
      kind: 'initial',
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

  const unacceptableLedger: [string, DispatchAcceptanceResult][] = [
    ['a missing ledger row', { outcome: 'not_found' }],
    [
      'an unacceptable ledger state',
      { outcome: 'unacceptable_state', state: 'ready', attemptCount: 1 },
    ],
  ];

  it.each(unacceptableLedger)(
    'still records the acceptance when the ledger reports %s',
    async (_label, acceptance) => {
      const { service, messageDispatches, verificationsRepo } = createMocks();
      // The provider handed back a wamid, so the message really was sent.
      // Rewriting that into `failed` is what left rows at `pending`/`failed`
      // with a NULL wa_message_id — which then also broke the delivery and
      // read webhooks, since they resolve against that id, and zeroed every
      // `last_sent_at`-derived dashboard metric.
      messageDispatches.markAccepted.mockResolvedValue(acceptance);

      const result = await service.sendInitial('ver-1');
      expect(result).toMatchObject({
        status: 'sent',
        waMessageId: 'wamid-1',
      });
      expect(typeof result.sentAt).toBe('string');
      expect(messageDispatches.markOutcomeUnknown).toHaveBeenCalledWith(
        'dispatch-1',
        'acceptance_persistence_failed',
      );
      expect(
        messageDispatches.projectAcceptanceWithoutLedger,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId: 'ver-1',
          kind: 'initial',
          providerMessageId: 'wamid-1',
        }),
      );
      // The send is not a failure, so nothing may stamp the row `failed`.
      expect(verificationsRepo.updateByIdForOrg).not.toHaveBeenCalled();
    },
  );

  it('records the acceptance when the ledger write throws', async () => {
    const { service, messageDispatches, verificationsRepo } = createMocks();
    messageDispatches.markAccepted.mockRejectedValue(new Error('db down'));

    await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
      status: 'sent',
      waMessageId: 'wamid-1',
    });
    expect(
      messageDispatches.projectAcceptanceWithoutLedger,
    ).toHaveBeenCalledTimes(1);
    expect(verificationsRepo.updateByIdForOrg).not.toHaveBeenCalled();
  });

  it.each([
    [
      'initial provider exception',
      'sendInitial' as const,
      new Error('timeout'),
      'provider_exception',
    ],
    [
      'initial missing provider message id',
      'sendInitial' as const,
      { messages: [] },
      'missing_provider_message_id',
    ],
    [
      'follow-up provider exception',
      'sendFollowUp' as const,
      new Error('timeout'),
      'provider_exception',
    ],
    [
      'follow-up missing provider message id',
      'sendFollowUp' as const,
      { messages: [] },
      'missing_provider_message_id',
    ],
  ])(
    'marks %s as unknown and releases its reservation',
    async (_label, method, result, errorCode) => {
      const { service, messageDispatches, messagingPort, verificationsRepo } =
        createMocks();
      if (result instanceof Error) {
        messagingPort.sendVerificationTemplate.mockRejectedValue(result);
      } else {
        messagingPort.sendVerificationTemplate.mockResolvedValue(result);
      }

      await expect(service[method]('ver-1')).resolves.toEqual({
        status: 'outcome_unknown',
        reason: 'provider_outcome_unknown',
      });
      expect(messageDispatches.markFailedProviderOutcome).toHaveBeenCalledWith(
        'dispatch-1',
        errorCode,
      );
      expect(messageDispatches.markOutcomeUnknown).not.toHaveBeenCalled();
      expect(verificationsRepo.updateByIdForOrg).not.toHaveBeenCalled();
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
