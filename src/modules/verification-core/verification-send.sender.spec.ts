/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { VerificationSendService } from './verification-send.service';
import {
  seededTemplateRegistry,
  seededRegistryTemplates,
} from '../../shared/messaging/testing/seeded-template-registry';
import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import {
  FEATURE_OFF_SENDER,
  type ResolvedSender,
} from '../../shared/ports/sender-resolver.port';

const own: ResolvedSender = {
  kind: 'merchant_own',
  connectionId: 'connection',
  reason: 'own_number',
  units: 1,
};

function setup(testOrder = false, overrides: Record<string, unknown> = {}) {
  const integration = {
    id: 'integration',
    orgId: 'org',
    platformType: 'shopify',
    isActive: true,
    billingStatus: 'active',
    billingPlanId: 'pro',
    billingActivatedAt: '2026-01-01T00:00:00Z',
    defaultLanguage: 'ar',
    logoHeaderEnabled: true,
    logoBannerUrl: 'https://example.test/logo.png',
    ...overrides,
  };
  const registry = seededTemplateRegistry(seededRegistryTemplates());
  const ar = seededRegistryTemplates().find(
    (template) => template.key === 'cod_confirm.ar.standard',
  )!;
  registry.listImageTwins = () =>
    Promise.resolve([
      {
        twinOf: {
          templateName: ar.templateName,
          languageCode: ar.languageCode,
        },
        imageTwinOfKey: ar.key,
        templateName: 'image-twin',
        languageCode: ar.languageCode,
        isActive: true,
        reviewStatus: 'approved',
      },
    ]);
  const resolver = { resolve: jest.fn().mockResolvedValue(own) };
  const claims = {
    claim: jest.fn().mockImplementation((input: { sender: ResolvedSender }) =>
      Promise.resolve({
        outcome: 'claimed',
        dispatch: {
          id: 'dispatch',
          senderKind: input.sender.kind,
          senderConnectionId: input.sender.connectionId,
          senderReason: input.sender.reason,
        },
      }),
    ),
    markAccepted: jest.fn().mockResolvedValue({ outcome: 'accepted' }),
    beginMerchantAttempt: jest
      .fn()
      .mockResolvedValue({ attemptId: 'attempt', claimToken: 'claim' }),
    acceptMerchantAttempt: jest.fn().mockResolvedValue(true),
  };
  const messaging = {
    sendVerificationTemplate: jest
      .fn()
      .mockResolvedValue({ messages: [{ id: 'wamid' }] }),
  };
  const changeTemplates = {
    counterpart: jest.fn().mockResolvedValue(null),
    selectVariant: jest.fn(),
  };
  changeTemplates.selectVariant.mockImplementation(
    async (base: Record<string, unknown>) => {
      const counterpart = await changeTemplates.counterpart(base);
      return {
        template: counterpart ?? base,
        ready: Boolean(counterpart),
        reason: counterpart ? null : 'change_text_unavailable',
      };
    },
  );
  const service = new VerificationSendService(
    {
      findById: () =>
        Promise.resolve({
          id: 'verification',
          orgId: 'org',
          orderId: 'order',
          status: 'sent',
        }),
    } as never,
    {
      findById: () =>
        Promise.resolve({
          id: 'order',
          orgId: 'org',
          integrationId: 'integration',
          integration,
          isTest: testOrder,
          customerPhone: '+201000000001',
          totalPrice: '100',
          currency: 'EGP',
          externalOrderId: '1',
        }),
    } as never,
    {
      evaluateAccess: (source: EntitlementSource) =>
        resolveEntitlement(source, source),
    } as never,
    { resolveDenial: () => Promise.resolve(null) } as never,
    claims as never,
    messaging as never,
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    resolver,
    undefined,
    undefined,
    changeTemplates as never,
  );
  return { service, resolver, claims, messaging, changeTemplates };
}

describe('sender selection in verification sends', () => {
  it.each([
    [false, true],
    [true, false],
    [true, true],
  ])(
    'selects three buttons only with opt-in=%s and readiness=%s',
    async (enabled, ready) => {
      const f = setup(false, { changeRequestsEnabled: enabled });
      if (ready)
        f.changeTemplates.counterpart.mockImplementation(
          (base: Record<string, unknown>) =>
            Promise.resolve({
              ...base,
              imageHeader: undefined,
              changeRequestOfKey: base.registryKey,
              registryKey: 'change-version',
              templateName: 'approved-change-version',
            }),
        );
      await f.service.sendInitial('verification');
      expect(f.claims.claim).toHaveBeenCalledWith(
        expect.objectContaining({ changeRequestButtons: enabled && ready }),
      );
      if (!enabled)
        expect(f.changeTemplates.counterpart).not.toHaveBeenCalled();
      expect(f.messaging.sendVerificationTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          template: expect.objectContaining(
            enabled && ready
              ? { templateName: 'approved-change-version' }
              : { templateName: expect.any(String) },
          ),
        }),
      );
    },
  );
  it('resolves independently per message after selection, claims before sending, and omits merchant logo headers', async () => {
    const { service, resolver, claims, messaging } = setup();
    await service.sendInitial('verification');
    resolver.resolve.mockResolvedValue(FEATURE_OFF_SENDER);
    await service.sendFollowUp('verification');
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(resolver.resolve).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orgId: 'org',
        template: expect.objectContaining({
          registryKey: 'cod_confirm.ar.standard',
        }),
      }),
    );
    const senderCall = resolver.resolve.mock.calls[0] as [
      { template: unknown },
    ];
    expect(senderCall[0].template).not.toHaveProperty('imageHeader');
    expect(claims.claim.mock.invocationCallOrder[0]).toBeLessThan(
      messaging.sendVerificationTemplate.mock.invocationCallOrder[0],
    );
    expect(messaging.sendVerificationTemplate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sender: own,
        dispatchContext: {
          orgId: 'org',
          dispatchId: 'dispatch',
          merchantAttempt: { attemptId: 'attempt', claimToken: 'claim' },
        },
        template: expect.not.objectContaining({
          imageHeader: expect.anything(),
        }),
      }),
    );
    expect(messaging.sendVerificationTemplate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sender: FEATURE_OFF_SENDER,
        template: expect.objectContaining({ imageHeader: expect.anything() }),
      }),
    );
  });

  it('passes the claimed identity on retry even when fresh resolution chooses Akeed', async () => {
    const { service, resolver, claims, messaging } = setup();
    resolver.resolve.mockResolvedValue(FEATURE_OFF_SENDER);
    claims.claim.mockResolvedValue({
      outcome: 'claimed',
      dispatch: {
        id: 'dispatch',
        senderKind: own.kind,
        senderConnectionId: own.connectionId,
        senderReason: own.reason,
      },
    });
    await service.sendInitial('verification');
    expect(messaging.sendVerificationTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: own,
        template: expect.not.objectContaining({
          imageHeader: expect.anything(),
        }),
      }),
    );
  });

  it.each([
    ['a chosen template', 'cod_confirm.ar.gulf', 'cod_confirm.ar.gulf'],
    ['a language fallback', 'cod_confirm.en.direct', 'cod_confirm.ar.standard'],
  ])(
    'resolves the exact registry key selected for %s',
    async (_label, storedKey, selectedKey) => {
      const { service, resolver } = setup(false, {
        codTemplateArKey: storedKey,
      });
      await service.sendInitial('verification');
      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(resolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          template: expect.objectContaining({
            registryKey: selectedKey,
            language: 'ar',
          }),
        }),
      );
    },
  );

  it('resolves synthetic test orders while keeping their billing exemption', async () => {
    const { service, resolver, claims } = setup(true);
    await service.sendInitial('verification', { billingExempt: true });
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(claims.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: own,
        billingExempt: true,
        identity: expect.objectContaining({ purpose: 'test' }),
      }),
    );
  });

  it('does not honor billing exemption for production orders', async () => {
    const { service, claims } = setup(false);
    await service.sendInitial('verification', { billingExempt: true });
    expect(claims.claim).toHaveBeenCalledWith(
      expect.objectContaining({ billingExempt: false }),
    );
  });
});
