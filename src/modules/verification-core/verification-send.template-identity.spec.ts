import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import { ConfirmedMessageRejection } from '../../shared/ports/messaging.port';
import { VerificationSendService } from './verification-send.service';

/**
 * US-08-02: every send records which template it carried. All sources and
 * channels reach WhatsApp through this one service, so the identity is pinned
 * here for each source and each kind of send.
 */
const PLATFORMS = ['shopify', 'standalone', 'easyorders', 'woocommerce'];

type SendPath = 'initial' | 'reminder' | 'onboarding test' | 'settings test';

const PATHS: {
  path: SendPath;
  kind: 'initial' | 'follow_up';
  isTest: boolean;
  billingExempt: boolean;
  purpose: 'initial' | 'reminder' | 'test';
}[] = [
  {
    path: 'initial',
    kind: 'initial',
    isTest: false,
    billingExempt: false,
    purpose: 'initial',
  },
  {
    path: 'reminder',
    kind: 'follow_up',
    isTest: false,
    billingExempt: false,
    purpose: 'reminder',
  },
  {
    path: 'onboarding test',
    kind: 'initial',
    isTest: true,
    billingExempt: true,
    purpose: 'test',
  },
  {
    path: 'settings test',
    kind: 'initial',
    isTest: true,
    billingExempt: false,
    purpose: 'test',
  },
];

const EGYPTIAN = {
  variantKey: 'ar.egyptian',
  language: 'ar',
  templateName: 'akeed_cod_verification_direct_eg',
  languageCode: 'ar_EG',
};

function createMocks(
  options: {
    platformType?: string;
    isTest?: boolean;
    integration?: Record<string, unknown>;
    customerPhone?: string;
  } = {},
) {
  const platformType = options.platformType ?? 'shopify';
  const integration = {
    id: 'int-1',
    orgId: 'org-1',
    platformType,
    isActive: true,
    // A plan-billed source other than Shopify is entitled by `not_required`.
    billingStatus: platformType === 'shopify' ? 'active' : 'not_required',
    billingPlanId: 'pro',
    billingActivatedAt: '2026-01-01T00:00:00Z',
    storeName: 'Akeed Fashion',
    defaultLanguage: 'auto',
    codTemplateArVariant: 'egyptian',
    codTemplateEnVariant: 'professional',
    ...options.integration,
  };
  const messageDispatches = {
    claim: jest.fn().mockResolvedValue({
      outcome: 'claimed',
      dispatch: { id: 'dispatch-1', dispatchKey: 'ver-1:initial:1' },
    }),
    markAccepted: jest.fn().mockResolvedValue({
      outcome: 'accepted',
      dispatch: { id: 'dispatch-1', state: 'accepted' },
    }),
    markOutcomeUnknown: jest.fn().mockResolvedValue(1),
    markFailedProviderOutcome: jest.fn().mockResolvedValue(1),
    projectAcceptanceWithoutLedger: jest.fn().mockResolvedValue(1),
    resolveNotAccepted: jest.fn().mockResolvedValue({ id: 'dispatch-1' }),
  };
  // Answers as the real adapter does: with the identity of what it sent.
  const messagingPort = {
    sendVerificationTemplate: jest.fn((params: { template: typeof EGYPTIAN }) =>
      Promise.resolve({
        messages: [{ id: 'wamid-1' }],
        template: {
          variantKey: params.template.variantKey,
          language: params.template.language,
          templateName: params.template.templateName,
          languageCode: params.template.languageCode,
        },
      }),
    ),
  };
  const service = new VerificationSendService(
    {
      findById: jest.fn().mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'pending',
      }),
    } as never,
    {
      findById: jest.fn().mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        integrationId: 'int-1',
        customerPhone: options.customerPhone ?? '+201001112223',
        customerName: 'Sara',
        externalOrderId: 'ext-1',
        orderNumber: '1117',
        totalPrice: '100.00',
        currency: 'EGP',
        isTest: options.isTest ?? false,
        integration,
      }),
    } as never,
    {
      evaluateAccess: (source: EntitlementSource) =>
        resolveEntitlement(source, source),
    } as never,
    { resolveDenial: jest.fn().mockResolvedValue(null) } as never,
    messageDispatches as never,
    messagingPort as never,
  );
  return { service, messageDispatches, messagingPort };
}

describe('VerificationSendService template identity', () => {
  const matrix = PLATFORMS.flatMap((platformType) =>
    PATHS.map((definition) => ({ platformType, ...definition })),
  );

  it.each(matrix)(
    'records the template of a $platformType $path',
    async ({ platformType, kind, isTest, billingExempt, purpose }) => {
      const { service, messageDispatches, messagingPort } = createMocks({
        platformType,
        isTest,
      });

      const outcome =
        kind === 'follow_up'
          ? await service.sendFollowUp('ver-1')
          : await service.sendInitial('ver-1', { billingExempt });

      expect(outcome.status).toBe('sent');
      // The claim carries the identity, so the row has it before the provider
      // is called.
      expect(messageDispatches.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          templateName: EGYPTIAN.templateName,
          languageCode: EGYPTIAN.languageCode,
          identity: {
            variantKey: EGYPTIAN.variantKey,
            purpose,
            language: EGYPTIAN.language,
          },
        }),
      );
      // The adapter is handed the same selection the claim recorded.
      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          template: expect.objectContaining(EGYPTIAN) as unknown,
        }),
      );
      // The acceptance records what the adapter reports it sent.
      expect(messageDispatches.markAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ kind, sentTemplate: EGYPTIAN }),
      );
    },
  );

  it('never writes the old placeholders', async () => {
    const { service, messageDispatches } = createMocks({
      integration: { defaultLanguage: 'auto' },
    });

    await service.sendInitial('ver-1');
    await service.sendFollowUp('ver-1');

    const claims = messageDispatches.claim.mock.calls as [
      { templateName: string; languageCode: string },
    ][];
    expect(claims).toHaveLength(2);
    for (const [claim] of claims) {
      expect(claim.templateName).not.toContain('cod_verification:');
      expect(claim.templateName).not.toBe('cod_verification');
      expect(claim.languageCode).not.toBe('auto');
    }
  });

  it('records the language the send resolved to, not the store preference', async () => {
    const { service, messageDispatches } = createMocks({
      customerPhone: '+14155550101',
    });

    await service.sendInitial('ver-1');

    expect(messageDispatches.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: '_akeed_cod_verification_professional',
        languageCode: 'en',
        identity: {
          variantKey: 'en.professional',
          purpose: 'initial',
          language: 'en',
        },
      }),
    );
  });

  it('records the default when the stored variant is unknown', async () => {
    const { service, messageDispatches } = createMocks({
      integration: { codTemplateArVariant: 'retired_variant' },
    });

    await service.sendInitial('ver-1');

    expect(messageDispatches.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'akeed_cod_verification_friendly',
        languageCode: 'ar',
        identity: {
          variantKey: 'ar.standard',
          purpose: 'initial',
          language: 'ar',
        },
      }),
    );
  });

  it.each([
    ['the provider call throws', new Error('timeout'), 'provider_exception'],
    [
      'the provider returns no message id',
      { messages: [] },
      'missing_provider_message_id',
    ],
  ])(
    'keeps the claimed identity for reconciliation when %s',
    async (_label, result, errorCode) => {
      const { service, messageDispatches, messagingPort } = createMocks();
      if (result instanceof Error)
        messagingPort.sendVerificationTemplate.mockRejectedValue(result);
      else
        messagingPort.sendVerificationTemplate.mockResolvedValue(
          result as never,
        );

      await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
        status: 'outcome_unknown',
      });

      // The identity went in with the claim, and the only later write parks
      // the row: nothing clears or replaces what the claim recorded.
      expect(messageDispatches.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: expect.objectContaining({
            variantKey: 'ar.egyptian',
          }) as unknown,
        }),
      );
      expect(messageDispatches.markFailedProviderOutcome).toHaveBeenCalledWith(
        'dispatch-1',
        errorCode,
      );
      expect(messageDispatches.markAccepted).not.toHaveBeenCalled();
    },
  );

  it('keeps the claimed identity when the provider confirms a rejection', async () => {
    const { service, messageDispatches, messagingPort } = createMocks({
      platformType: 'standalone',
    });
    messageDispatches.claim.mockResolvedValue({
      outcome: 'claimed',
      dispatch: { id: 'dispatch-1', accountingMode: 'prepaid_credit' },
    });
    messagingPort.sendVerificationTemplate.mockRejectedValue(
      new ConfirmedMessageRejection('provider_rejected'),
    );

    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'failed',
      reason: 'provider_not_accepted',
    });
    expect(messageDispatches.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          variantKey: 'ar.egyptian',
        }) as unknown,
      }),
    );
    expect(messageDispatches.markAccepted).not.toHaveBeenCalled();
  });

  it('leaves the claimed identity in place when an adapter does not report one', async () => {
    const { service, messageDispatches, messagingPort } = createMocks();
    messagingPort.sendVerificationTemplate.mockResolvedValue({
      messages: [{ id: 'wamid-1' }],
    } as never);

    await service.sendInitial('ver-1');

    const [acceptance] = messageDispatches.markAccepted.mock.calls[0] as [
      { sentTemplate?: unknown },
    ];
    expect(acceptance.sentTemplate).toBeUndefined();
  });

  it('still gives the verification its template when the ledger write fails', async () => {
    const { service, messageDispatches } = createMocks();
    messageDispatches.markAccepted.mockRejectedValue(new Error('db down'));

    await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
      status: 'sent',
    });
    expect(
      messageDispatches.projectAcceptanceWithoutLedger,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationId: 'ver-1',
        providerMessageId: 'wamid-1',
        template: EGYPTIAN,
      }),
    );
  });
});
