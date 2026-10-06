import { Logger } from '@nestjs/common';
import {
  resolveEntitlement,
  type EntitlementSource,
} from '../../shared/billing/entitlement';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  type MessageImprovementSwitchState,
} from '../../shared/config/whatsapp-template.config';
import {
  reminderTemplate,
  seededRegistryTemplates,
  seededTemplateRegistry,
} from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import { VerificationSendService } from './verification-send.service';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/**
 * US-08-07 on the send path, one switch at a time. With every switch off the
 * payload is covered by the characterization suite; these are the on-cases.
 */
function setup(
  options: {
    templates?: RegistryTemplate[];
    integration?: Record<string, unknown>;
    order?: Record<string, unknown>;
    switches?: Partial<MessageImprovementSwitchState>;
    texts?: Partial<Record<string, string>>;
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
    defaultLanguage: 'auto',
    codTemplateArVariant: 'standard',
    codTemplateEnVariant: 'friendly',
    codTemplateArKey: 'cod_confirm.ar.short',
    codTemplateEnKey: null,
    codReminderArKey: null,
    codReminderEnKey: null,
    codTemplateArAuto: false,
    ...options.integration,
  };
  const messageDispatches = {
    claim: jest.fn().mockResolvedValue({
      outcome: 'claimed',
      dispatch: { id: 'dispatch-1', dispatchKey: 'ver-1:follow_up:1' },
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
  const switches = { ...MESSAGE_IMPROVEMENT_SWITCHES_OFF, ...options.switches };
  const service = new VerificationSendService(
    {
      findById: jest.fn().mockResolvedValue({
        id: 'ver-1',
        orderId: 'order-1',
        orgId: 'org-1',
        status: 'sent',
      }),
    } as never,
    {
      findById: jest.fn().mockResolvedValue({
        id: 'order-1',
        orgId: 'org-1',
        integrationId: 'int-1',
        customerPhone: '+966501234567',
        customerName: 'Sara',
        externalOrderId: 'ext-1',
        orderNumber: '1117',
        totalPrice: '1250.00',
        currency: 'SAR',
        isTest: false,
        integration,
        ...options.order,
      }),
    } as never,
    {
      evaluateAccess: (source: EntitlementSource) =>
        resolveEntitlement(source, source),
    } as never,
    { resolveDenial: jest.fn().mockResolvedValue(null) } as never,
    messageDispatches as never,
    messagingPort as never,
    seededTemplateRegistry(options.templates ?? seededRegistryTemplates()),
    undefined,
    { current: () => switches } as never,
    {
      resolve: jest.fn((purpose: string, language: string) =>
        Promise.resolve(
          options.texts?.[`${purpose}.${language}`] === undefined
            ? null
            : { body: options.texts[`${purpose}.${language}`] },
        ),
      ),
    } as never,
  );
  return { service, messageDispatches, messagingPort };
}

function claimed(dispatches: { claim: jest.Mock }) {
  const [params] = dispatches.claim.mock.calls[0] as [
    { templateName: string; identity: Record<string, unknown> },
  ];
  return { templateName: params.templateName, identity: params.identity };
}

const REMINDERS = [
  ...seededRegistryTemplates(),
  reminderTemplate('ar', 'standard_v1', { isDefault: true }),
  reminderTemplate('ar', 'gulf_v1'),
];

describe('VerificationSendService and US-08-07', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('a. reminder purpose', () => {
    it('sends the chosen reminder template as the follow-up, recorded as a reminder', async () => {
      const { service, messageDispatches, messagingPort } = setup({
        templates: REMINDERS,
        integration: { codReminderArKey: 'cod_reminder.ar.gulf_v1' },
        switches: { reminderTemplate: true },
      });
      await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
        status: 'sent',
      });
      expect(claimed(messageDispatches)).toEqual({
        templateName: 'akeed_cod_reminder_gulf_v1',
        identity: {
          variantKey: 'ar.gulf_v1',
          purpose: 'reminder',
          language: 'ar',
        },
      });
      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          template: expect.objectContaining({
            templateName: 'akeed_cod_reminder_gulf_v1',
          }),
        }),
      );
    });

    it('never uses the reminder for the first send', async () => {
      const { service, messageDispatches } = setup({
        templates: REMINDERS,
        integration: { codReminderArKey: 'cod_reminder.ar.gulf_v1' },
        switches: { reminderTemplate: true },
      });
      await service.sendInitial('ver-1');
      expect(claimed(messageDispatches).templateName).toBe(
        'akeed_cod_verification',
      );
    });

    it('with the switch off, a chosen reminder is ignored', async () => {
      const { service, messageDispatches } = setup({
        templates: REMINDERS,
        integration: { codReminderArKey: 'cod_reminder.ar.gulf_v1' },
      });
      await service.sendFollowUp('ver-1');
      expect(claimed(messageDispatches)).toEqual({
        templateName: 'akeed_cod_verification',
        identity: {
          variantKey: 'ar.short',
          purpose: 'reminder',
          language: 'ar',
        },
      });
    });

    it('records reminder_unavailable and the passed-over key when it falls to the first-send template', async () => {
      const { service, messageDispatches } = setup({
        templates: [
          ...seededRegistryTemplates(),
          reminderTemplate('ar', 'gulf_v1', { isActive: false }),
        ],
        integration: { codReminderArKey: 'cod_reminder.ar.gulf_v1' },
        switches: { reminderTemplate: true },
      });
      await expect(service.sendFollowUp('ver-1')).resolves.toMatchObject({
        status: 'sent',
      });
      expect(claimed(messageDispatches)).toEqual({
        templateName: 'akeed_cod_verification',
        identity: {
          variantKey: 'ar.short',
          purpose: 'reminder',
          language: 'ar',
          fallbackReason: 'reminder_unavailable',
          skippedKey: 'cod_reminder.ar.gulf_v1',
        },
      });
    });
  });

  describe('d. Arabic style by country', () => {
    it('a store on auto sends a Saudi number the Gulf style', async () => {
      const { service, messageDispatches } = setup({
        integration: { codTemplateArAuto: true },
        switches: { arabicStyleAuto: true },
      });
      await service.sendInitial('ver-1');
      expect(claimed(messageDispatches)).toEqual({
        templateName: 'akeed_cod_verification_direct_gulf',
        identity: { variantKey: 'ar.gulf', purpose: 'initial', language: 'ar' },
      });
    });

    it('records auto_style_unavailable when the mapped style cannot be sent', async () => {
      const { service, messageDispatches } = setup({
        templates: seededRegistryTemplates().map((template) =>
          template.key === 'cod_confirm.ar.gulf'
            ? { ...template, isActive: false }
            : template,
        ),
        integration: { codTemplateArAuto: true },
        switches: { arabicStyleAuto: true },
      });
      await service.sendInitial('ver-1');
      expect(claimed(messageDispatches)).toEqual({
        templateName: 'akeed_cod_verification_friendly',
        identity: {
          variantKey: 'ar.standard',
          purpose: 'initial',
          language: 'ar',
          fallbackReason: 'auto_style_unavailable',
          skippedKey: 'cod_confirm.ar.gulf',
        },
      });
    });

    it('with the switch off, a store on auto sends its stored style', async () => {
      const { service, messageDispatches } = setup({
        integration: { codTemplateArAuto: true },
      });
      await service.sendInitial('ver-1');
      expect(claimed(messageDispatches).templateName).toBe(
        'akeed_cod_verification',
      );
    });
  });

  describe('e. localized name fallbacks', () => {
    const TEXTS = {
      'fallback_customer_name.ar': 'عميلنا العزيز',
      'fallback_store_name.ar': 'متجرنا',
      'fallback_customer_name.en': 'there',
      'fallback_store_name.en': 'our store',
    };

    function sentParams(messagingPort: {
      sendVerificationTemplate: jest.Mock;
    }) {
      const [params] = messagingPort.sendVerificationTemplate.mock.calls[0] as [
        { fallbacks?: Record<string, string>; totalPrice: string },
      ];
      return params;
    }

    it.each([
      ['+966501234567', 'عميلنا العزيز', 'متجرنا'],
      ['+14155550101', 'there', 'our store'],
    ])(
      'hands the adapter the words of the send language for %s',
      async (phone, customer, store) => {
        const { service, messagingPort } = setup({
          order: { customerName: '  ', customerPhone: phone },
          integration: { storeName: null },
          switches: { localizedFallbacks: true },
          texts: TEXTS,
        });
        await service.sendInitial('ver-1');
        expect(sentParams(messagingPort).fallbacks).toEqual({
          customer,
          store,
        });
      },
    );

    it('reads no word for a name that is present', async () => {
      const { service, messagingPort } = setup({
        switches: { localizedFallbacks: true },
        texts: TEXTS,
      });
      await service.sendInitial('ver-1');
      expect(sentParams(messagingPort)).not.toHaveProperty('fallbacks');
    });

    it('with the switch off, passes no fallbacks', async () => {
      const { service, messagingPort } = setup({
        order: { customerName: null },
        integration: { storeName: null },
        texts: TEXTS,
      });
      await service.sendInitial('ver-1');
      expect(sentParams(messagingPort)).not.toHaveProperty('fallbacks');
    });

    it('a missing text leaves that word to the adapter, logs why, and still sends', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const { service, messagingPort } = setup({
        order: { customerName: null },
        integration: { storeName: null },
        switches: { localizedFallbacks: true },
        texts: { 'fallback_customer_name.ar': 'عميلنا العزيز' },
      });
      await expect(service.sendInitial('ver-1')).resolves.toMatchObject({
        status: 'sent',
      });
      expect(sentParams(messagingPort).fallbacks).toEqual({
        customer: 'عميلنا العزيز',
      });
      expect(
        warn.mock.calls.map(([line]) => JSON.parse(String(line)) as object),
      ).toContainEqual(
        expect.objectContaining({
          action: 'sendOnce.localizedFallback',
          purpose: 'fallback_store_name',
          reason: 'message_text_unavailable',
        }),
      );
    });
  });

  describe('f. amount formatting', () => {
    it.each([
      ['+966501234567', 'SAR', '1,250.00 ر.س'],
      ['+14155550101', 'SAR', 'SAR 1,250.00'],
      ['+201001112223', 'EGP', '1,250.00 ج.م'],
      ['+14155550101', 'KWD', 'KWD 1,250.000'],
      ['+14155550101', null, '1,250.00'],
    ])(
      'writes the total for %s in %s as %s',
      async (phone, currency, total) => {
        const { service, messagingPort } = setup({
          order: { customerPhone: phone, currency },
          switches: { amountFormatting: true },
        });
        await service.sendInitial('ver-1');
        expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledWith(
          expect.objectContaining({ totalPrice: total }),
        );
      },
    );

    it('with the switch off, sends the total as before', async () => {
      const { service, messagingPort } = setup();
      await service.sendInitial('ver-1');
      expect(messagingPort.sendVerificationTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ totalPrice: '1250.00 SAR' }),
      );
    });
  });
});
