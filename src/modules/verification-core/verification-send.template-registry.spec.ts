import { Logger } from '@nestjs/common';
import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import {
  seededRegistryTemplates,
  seededTemplateRegistry,
} from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import { VerificationSendService } from './verification-send.service';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/**
 * US-08-03: the send path takes its template from the registry. A stored
 * choice that cannot be sent falls back to the language default with a logged
 * reason, and with no default the send is skipped before anything is claimed.
 */
function setup(
  options: {
    templates?: RegistryTemplate[];
    integration?: Record<string, unknown>;
    kind?: 'initial' | 'follow_up';
  } = {},
) {
  const integration = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    isActive: true,
    billingStatus: 'active',
    billingPlanId: 'pro',
    billingActivatedAt: '2026-01-01T00:00:00Z',
    storeName: 'Akeed Fashion',
    defaultLanguage: 'ar',
    codTemplateArVariant: 'standard',
    codTemplateEnVariant: 'friendly',
    codTemplateArKey: null,
    codTemplateEnKey: null,
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
  };
  const messagingPort = {
    sendVerificationTemplate: jest
      .fn()
      .mockResolvedValue({ messages: [{ id: 'wamid-1' }] }),
  };
  const registry = seededTemplateRegistry(
    options.templates ?? seededRegistryTemplates(),
  );
  const service = new VerificationSendService(
    {
      findById: jest.fn().mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: options.kind === 'follow_up' ? 'sent' : 'pending',
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
        isTest: false,
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
    registry,
  );
  return { service, messageDispatches, messagingPort };
}

function withRow(key: string, change: Partial<RegistryTemplate>) {
  return seededRegistryTemplates().map((template) =>
    template.key === key ? { ...template, ...change } : template,
  );
}

function loggedEntries(spy: jest.SpyInstance): Record<string, unknown>[] {
  return spy.mock.calls.map(
    ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
  );
}

describe('VerificationSendService and the template registry', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends the template the stored key names', async () => {
    const { service, messageDispatches, messagingPort } = setup({
      integration: { codTemplateArKey: 'cod_confirm.ar.gulf' },
    });

    await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
      status: 'sent',
    });

    expect(messageDispatches.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'akeed_cod_verification_direct_gulf',
        languageCode: 'ar',
        identity: { variantKey: 'ar.gulf', purpose: 'initial', language: 'ar' },
      }),
    );
    expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        template: {
          variantKey: 'ar.gulf',
          language: 'ar',
          templateName: 'akeed_cod_verification_direct_gulf',
          languageCode: 'ar',
          parameterFormat: 'named',
          variables: [
            { key: 'customer', name: 'customer' },
            { key: 'order', name: 'order' },
            { key: 'store', name: 'store' },
            { key: 'total', name: 'total' },
          ],
        },
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('prefers the stored key over the old variant column', async () => {
    const { service, messageDispatches } = setup({
      integration: {
        codTemplateArKey: 'cod_confirm.ar.short',
        codTemplateArVariant: 'egyptian',
      },
    });

    await service.sendInitial('ver-1');

    expect(messageDispatches.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ variantKey: 'ar.short' }),
      }),
    );
  });

  it.each([
    [
      'an unknown key',
      { codTemplateArKey: 'cod_confirm.ar.retired' },
      seededRegistryTemplates(),
      'cod_confirm.ar.retired',
      'key_unknown',
    ],
    [
      'an inactive key',
      { codTemplateArKey: 'cod_confirm.ar.gulf' },
      withRow('cod_confirm.ar.gulf', { isActive: false }),
      'cod_confirm.ar.gulf',
      'key_inactive',
    ],
    [
      'a key of the other language',
      { codTemplateArKey: 'cod_confirm.en.direct' },
      seededRegistryTemplates(),
      'cod_confirm.en.direct',
      'wrong_language',
    ],
  ])(
    'falls back to the default for %s and logs the reason',
    async (_label, integration, templates, storedKey, reason) => {
      const { service, messageDispatches } = setup({ integration, templates });

      await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
        status: 'sent',
      });

      expect(messageDispatches.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: 'akeed_cod_verification_friendly',
          languageCode: 'ar',
          identity: {
            variantKey: 'ar.standard',
            purpose: 'reminder',
            language: 'ar',
          },
        }),
      );
      expect(loggedEntries(warn)).toEqual([
        expect.objectContaining({
          module: 'VerificationSendService',
          action: 'sendOnce.templateFallback',
          verificationId: 'ver-1',
          integrationId: 'int-1',
          storedTemplateKey: storedKey,
          variantKey: 'ar.standard',
          reason,
        }),
      ]);
    },
  );

  it('uses the default quietly when a store has no choice stored', async () => {
    const { service, messageDispatches } = setup({
      integration: { codTemplateArVariant: null },
    });

    await service.sendInitial('ver-1');

    expect(messageDispatches.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ variantKey: 'ar.standard' }),
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['is inactive', { isActive: false, isDefault: false }],
    ['has lost the default flag', { isDefault: false }],
  ])(
    'skips before the claim when the stored key is unusable and the default %s',
    async (_label, change) => {
      const { service, messageDispatches, messagingPort } = setup({
        integration: { codTemplateArKey: 'cod_confirm.ar.retired' },
        templates: withRow('cod_confirm.ar.standard', change),
      });

      await expect(service.sendInitial('ver-1')).resolves.toEqual({
        status: 'skipped',
        reason: 'template_unavailable',
      });

      expect(messageDispatches.claim).not.toHaveBeenCalled();
      expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
      expect(loggedEntries(error)).toEqual([
        expect.objectContaining({
          action: 'sendOnce.templateSelection',
          outcome: 'skipped',
          verificationId: 'ver-1',
          resolvedLanguage: 'ar',
          storedTemplateKey: 'cod_confirm.ar.retired',
          reason: 'template_unavailable',
        }),
      ]);
    },
  );

  it('logs identifiers only: no template text, name or phone', async () => {
    const { service } = setup({
      integration: { codTemplateArKey: 'cod_confirm.ar.retired' },
    });

    await service.sendInitial('ver-1');

    const logged = JSON.stringify(loggedEntries(warn));
    expect(logged).not.toContain('Sara');
    expect(logged).not.toContain('201001112223');
    expect(logged).not.toContain('{{');
  });
});
