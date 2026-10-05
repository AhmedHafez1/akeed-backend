import { Logger } from '@nestjs/common';
import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import { syncedApprovedTemplates } from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import type { TemplateRegistryPort } from '../../shared/ports/template-registry.port';
import { VerificationSendService } from './verification-send.service';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/**
 * US-08-04 criterion 4: with the guardrail on, a send uses only a template
 * that is active in Akeed and approved at the provider. Otherwise it falls
 * back to the language default and records why on the dispatch, or, with no
 * sendable default, it is skipped before the claim so no usage is reserved.
 */
function setup(options: {
  templates: RegistryTemplate[];
  guardrail?: boolean;
  integration?: Record<string, unknown>;
}) {
  let templates = options.templates;
  const registry: TemplateRegistryPort = {
    listTemplates: () => Promise.resolve(templates),
    invalidate: () => undefined,
    sendGuardrailEnabled: () => options.guardrail ?? true,
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
    defaultLanguage: 'ar',
    codTemplateArVariant: 'egyptian',
    codTemplateEnVariant: 'friendly',
    codTemplateArKey: 'cod_confirm.ar.egyptian',
    codTemplateEnKey: 'cod_confirm.en.friendly',
    ...options.integration,
  };
  const verification = {
    id: 'ver-1',
    orderId: 'order-1',
    orgId: 'org-1',
    status: 'pending',
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
  const messagingPort = {
    sendVerificationTemplate: jest
      .fn()
      .mockResolvedValue({ messages: [{ id: 'wamid-1' }] }),
  };
  const service = new VerificationSendService(
    { findById: jest.fn().mockImplementation(() => verification) } as never,
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
  return {
    service,
    messageDispatches,
    messagingPort,
    verification,
    setTemplates: (next: RegistryTemplate[]) => {
      templates = next;
    },
  };
}

function syncedWith(
  changes: Record<string, Partial<RegistryTemplate>>,
): RegistryTemplate[] {
  return syncedApprovedTemplates().map((template) =>
    changes[template.key]
      ? { ...template, ...changes[template.key] }
      : template,
  );
}

function sentTemplateName(messagingPort: {
  sendVerificationTemplate: jest.Mock;
}): string {
  const [params] = messagingPort.sendVerificationTemplate.mock.calls.at(-1) as [
    { template: { templateName: string; languageCode: string } },
  ];
  return `${params.template.templateName}/${params.template.languageCode}`;
}

describe('VerificationSendService with the template guardrail', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends the selected template when it is approved, with no fallback recorded', async () => {
    const { service, messageDispatches, messagingPort } = setup({
      templates: syncedApprovedTemplates(),
    });

    await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
      status: 'sent',
    });
    expect(sentTemplateName(messagingPort)).toBe(
      'akeed_cod_verification_direct_eg/ar_EG',
    );
    const [claim] = messageDispatches.claim.mock.calls[0] as [
      { identity: Record<string, unknown> },
    ];
    expect(claim.identity).not.toHaveProperty('fallbackReason');
  });

  it('falls back to the language default and records the reason and the skipped key on the claim', async () => {
    const { service, messageDispatches, messagingPort } = setup({
      templates: syncedWith({
        'cod_confirm.ar.egyptian': { reviewStatus: 'paused' },
      }),
    });

    await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
      status: 'sent',
    });
    expect(sentTemplateName(messagingPort)).toBe(
      'akeed_cod_verification_friendly/ar',
    );
    expect(messageDispatches.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'akeed_cod_verification_friendly',
        identity: {
          variantKey: 'ar.standard',
          purpose: 'initial',
          language: 'ar',
          fallbackReason: 'not_approved',
          skippedKey: 'cod_confirm.ar.egyptian',
        },
      }),
    );
  });

  it('skips with template_unavailable before the claim when the default is unavailable too, so no usage is reserved', async () => {
    const { service, messageDispatches, messagingPort } = setup({
      templates: syncedWith({
        'cod_confirm.ar.egyptian': { reviewStatus: 'paused' },
        'cod_confirm.ar.standard': { reviewStatus: 'missing' },
      }),
    });

    await expect(service.sendInitial('ver-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'template_unavailable',
    });
    expect(messageDispatches.claim).not.toHaveBeenCalled();
    expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
    const logged = error.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logged).toContainEqual(
      expect.objectContaining({
        action: 'sendOnce.templateSelection',
        reason: 'template_unavailable',
        resolvedLanguage: 'ar',
      }),
    );
  });

  it('never sends the English template when no Arabic one is sendable', async () => {
    const { service, messagingPort } = setup({
      templates: syncedWith({
        'cod_confirm.ar.egyptian': { reviewStatus: 'rejected' },
        'cod_confirm.ar.standard': { reviewStatus: 'disabled' },
      }),
    });

    await service.sendInitial('ver-1');

    expect(messagingPort.sendVerificationTemplate).not.toHaveBeenCalled();
  });

  it('re-reads the registry for the reminder, so a template paused mid-queue falls back', async () => {
    const {
      service,
      messageDispatches,
      messagingPort,
      verification,
      setTemplates,
    } = setup({ templates: syncedApprovedTemplates() });

    await service.sendInitial('ver-1');
    expect(sentTemplateName(messagingPort)).toBe(
      'akeed_cod_verification_direct_eg/ar_EG',
    );

    verification.status = 'sent';
    setTemplates(
      syncedWith({ 'cod_confirm.ar.egyptian': { reviewStatus: 'paused' } }),
    );
    await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
      status: 'sent',
    });

    expect(sentTemplateName(messagingPort)).toBe(
      'akeed_cod_verification_friendly/ar',
    );
    expect(messageDispatches.claim).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'follow_up',
        identity: expect.objectContaining({
          purpose: 'reminder',
          fallbackReason: 'not_approved',
          skippedKey: 'cod_confirm.ar.egyptian',
        }),
      }),
    );
  });

  it('skips the reminder when the template and the default were paused after the first send', async () => {
    const {
      service,
      messageDispatches,
      messagingPort,
      verification,
      setTemplates,
    } = setup({ templates: syncedApprovedTemplates() });

    await service.sendInitial('ver-1');
    verification.status = 'sent';
    setTemplates(
      syncedWith({
        'cod_confirm.ar.egyptian': { reviewStatus: 'paused' },
        'cod_confirm.ar.standard': { reviewStatus: 'paused' },
      }),
    );

    await expect(service.sendFollowUp('ver-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'template_unavailable',
    });
    expect(messageDispatches.claim).toHaveBeenCalledTimes(1);
    expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledTimes(1);
  });

  it('sends as today when the switch is off, whatever the provider says', async () => {
    const { service, messagingPort } = setup({
      guardrail: false,
      templates: syncedWith({
        'cod_confirm.ar.egyptian': { reviewStatus: 'paused' },
        'cod_confirm.ar.standard': { reviewStatus: 'paused' },
      }),
    });

    await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
      status: 'sent',
    });
    expect(sentTemplateName(messagingPort)).toBe(
      'akeed_cod_verification_direct_eg/ar_EG',
    );
  });

  it('sends as today before the environment has ever synced', async () => {
    const neverSynced = syncedApprovedTemplates().map((template) => ({
      ...template,
      reviewStatus: null,
      category: null,
      lastSyncedAt: null,
    }));
    const { service, messagingPort } = setup({ templates: neverSynced });

    await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
      status: 'sent',
    });
    expect(sentTemplateName(messagingPort)).toBe(
      'akeed_cod_verification_direct_eg/ar_EG',
    );
  });
});
