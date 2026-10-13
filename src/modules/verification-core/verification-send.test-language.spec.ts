import { Logger } from '@nestjs/common';
import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import { syncedApprovedTemplates } from '../../shared/messaging/testing/seeded-template-registry';
import type { TemplateRegistryPort } from '../../shared/ports/template-registry.port';
import { VerificationSendService } from './verification-send.service';

/**
 * A test message can ask for its language, so Settings sends the language it
 * previews. An order from a customer never can: its language comes from the
 * store's setting and the customer's number.
 */
function setup(options: { isTest: boolean }) {
  const registry: TemplateRegistryPort = {
    listTemplates: () => Promise.resolve(syncedApprovedTemplates()),
    invalidate: () => undefined,
    sendGuardrailEnabled: () => true,
  };
  const integration = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    isActive: true,
    billingStatus: 'active',
    billingPlanId: 'pro',
    billingActivatedAt: '2026-01-01T00:00:00Z',
    storeName: 'Akeed Fashion',
    // Automatic: an Egyptian number resolves to Arabic.
    defaultLanguage: 'auto',
    codTemplateArKey: 'cod_confirm.ar.egyptian',
    codTemplateEnKey: 'cod_confirm.en.professional',
  };
  const messageDispatches = {
    claim: jest.fn().mockResolvedValue({
      outcome: 'claimed',
      dispatch: { id: 'dispatch-1' },
    }),
    markAccepted: jest.fn().mockResolvedValue({
      outcome: 'accepted',
      dispatch: { id: 'dispatch-1', state: 'accepted' },
    }),
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
        customerPhone: '+201001112223',
        customerName: 'Sara',
        externalOrderId: 'ext-1',
        orderNumber: '1117',
        totalPrice: '100.00',
        currency: 'EGP',
        isTest: options.isTest,
        integration,
      }),
    } as never,
    {
      evaluateAccess: (source: EntitlementSource) =>
        resolveEntitlement(source, source),
    } as never,
    { resolveDenial: jest.fn().mockResolvedValue(null) } as never,
    messageDispatches as never,
    {
      sendVerificationTemplate: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid-1' }] }),
    } as never,
    registry,
  );
  const claimedIdentity = () => {
    const [claim] = messageDispatches.claim.mock.calls.at(-1) as [
      { identity: { language: string; variantKey: string } },
    ];
    return claim.identity;
  };
  return { service, claimedIdentity };
}

describe('VerificationSendService test language', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends a test in the language asked for, with the store style for it', async () => {
    const { service, claimedIdentity } = setup({ isTest: true });

    await expect(
      service.sendInitial('ver-1', { testLanguage: 'en' }),
    ).resolves.toMatchObject({ status: 'sent' });

    expect(claimedIdentity()).toMatchObject({
      language: 'en',
      variantKey: 'en.professional',
    });
  });

  it('resolves a test without one as any send does', async () => {
    const { service, claimedIdentity } = setup({ isTest: true });

    await service.sendInitial('ver-1');

    expect(claimedIdentity()).toMatchObject({ language: 'ar' });
  });

  it('ignores the language for an order that is not a test', async () => {
    const { service, claimedIdentity } = setup({ isTest: false });

    await service.sendInitial('ver-1', { testLanguage: 'en' });

    expect(claimedIdentity()).toMatchObject({ language: 'ar' });
  });
});
