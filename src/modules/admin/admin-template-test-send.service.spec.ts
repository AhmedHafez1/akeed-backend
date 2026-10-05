import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { WhatsAppService } from '../../infrastructure/spokes/meta/whatsapp.service';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import {
  seededRegistryTemplates,
  seededTemplateRegistry,
  syncedApprovedTemplates,
} from '../../shared/messaging/testing/seeded-template-registry';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import type { MessagingPort } from '../../shared/ports/messaging.port';
import {
  AdminTemplateTestSendService,
  WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION,
} from './admin-template-test-send.service';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const STAFF_PHONE = '+201001234567';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

interface MetaPayload {
  to: string;
  template: {
    components: {
      type: string;
      parameters: { parameter_name?: string; text?: string }[];
    }[];
  };
}

function setup(
  options: {
    templates?: RegistryTemplate[];
    phones?: string;
    messaging?: MessagingPort;
    latestAllowedAt?: string | null;
    sentToday?: number;
  } = {},
) {
  const sendVerificationTemplate = jest
    .fn()
    .mockResolvedValue({ messages: [{ id: 'wamid.test' }] });
  const messaging: MessagingPort = options.messaging ?? {
    sendVerificationTemplate,
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    latestAllowedAt: jest
      .fn()
      .mockResolvedValue(options.latestAllowedAt ?? null),
    countAllowedSince: jest.fn().mockResolvedValue(options.sentToday ?? 0),
  };
  const values: Record<string, unknown> = {
    [WHATSAPP_TEMPLATE_CONFIG]: parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_TEST_PHONES: options.phones ?? STAFF_PHONE,
    }),
  };
  const service = new AdminTemplateTestSendService(
    seededTemplateRegistry(options.templates ?? syncedApprovedTemplates()),
    messaging,
    audit as never,
    { get: (key: string) => values[key] } as never,
  );
  return { service, audit, sendVerificationTemplate };
}

async function rejection(promise: Promise<unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  try {
    await promise;
  } catch (error) {
    const http = error as {
      getStatus(): number;
      getResponse(): Record<string, unknown>;
    };
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error('expected a rejection');
}

describe('AdminTemplateTestSendService', () => {
  let logs: jest.SpyInstance[];

  beforeEach(() => {
    logs = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
    ];
  });

  afterEach(() => jest.restoreAllMocks());

  const logged = () =>
    logs
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .map(([line]) => String(line))
      .join('\n');

  it('sends the template with sample values to a listed phone and audits it', async () => {
    const { service, audit, sendVerificationTemplate } = setup();

    await expect(
      service.send({
        userId: OPERATOR,
        key: 'cod_confirm.ar.egyptian',
        phone: ' +20 100 123 4567 ',
        requestId: 'req-1',
      }),
    ).resolves.toEqual({ accepted: true });

    expect(sendVerificationTemplate).toHaveBeenCalledTimes(1);
    const [params] = sendVerificationTemplate.mock.calls[0] as [
      Parameters<MessagingPort['sendVerificationTemplate']>[0],
    ];
    expect(params).toMatchObject({
      to: STAFF_PHONE,
      customerName: 'أحمد',
      storeName: 'متجر أكيد',
      orderNumber: 'TEST-1',
      totalPrice: '250.00 USD',
      template: {
        variantKey: 'ar.egyptian',
        templateName: 'akeed_cod_verification_direct_eg',
        languageCode: 'ar_EG',
        parameterFormat: 'named',
      },
    });
    expect(params.verificationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(audit.record).toHaveBeenCalledWith({
      userId: OPERATOR,
      action: WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION,
      outcome: 'allowed',
      requestId: 'req-1',
      metadata: { templateKey: 'cod_confirm.ar.egyptian', purpose: 'test' },
    });
  });

  it('keeps the phone and the template text out of the audit row and the logs', async () => {
    const { service, audit } = setup();

    await service.send({
      userId: OPERATOR,
      key: 'cod_confirm.en.friendly',
      phone: STAFF_PHONE,
    });

    const written = `${JSON.stringify(audit.record.mock.calls)}\n${logged()}`;
    expect(written).not.toContain('201001234567');
    expect(written).not.toContain('Ahmed');
    expect(written).not.toContain('Akeed Store');
  });

  it('uses a new ID for every send, so its buttons name no verification', async () => {
    const { service, sendVerificationTemplate } = setup();

    for (const key of ['cod_confirm.en.friendly', 'cod_confirm.en.short']) {
      await service.send({ userId: OPERATOR, key, phone: STAFF_PHONE });
    }

    const ids = sendVerificationTemplate.mock.calls.map(
      ([params]: [{ verificationId: string }]) => params.verificationId,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('is off until a test phone is listed', async () => {
    const { service, sendVerificationTemplate } = setup({ phones: '' });

    const refused = await rejection(
      service.send({
        userId: OPERATOR,
        key: 'cod_confirm.en.friendly',
        phone: STAFF_PHONE,
      }),
    );

    expect(refused).toMatchObject({
      status: 403,
      body: { code: 'WHATSAPP_TEMPLATE_TEST_SEND_DISABLED' },
    });
    expect(sendVerificationTemplate).not.toHaveBeenCalled();
  });

  it.each(['+201009999999', '0100 123 4567', 'not a phone', ''])(
    'refuses a phone that is not on the list (%p)',
    async (phone) => {
      const { service, audit, sendVerificationTemplate } = setup();

      const refused = await rejection(
        service.send({ userId: OPERATOR, key: 'cod_confirm.en.short', phone }),
      );

      expect(refused).toMatchObject({
        status: 403,
        body: { code: 'WHATSAPP_TEMPLATE_TEST_PHONE_NOT_ALLOWED' },
      });
      expect(JSON.stringify(refused.body)).not.toContain('9999999');
      expect(sendVerificationTemplate).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('answers 404 for a key the registry does not have', async () => {
    const { service } = setup();

    await expect(
      rejection(
        service.send({
          userId: OPERATOR,
          key: 'cod_confirm.en.retired',
          phone: STAFF_PHONE,
        }),
      ),
    ).resolves.toMatchObject({
      status: 404,
      body: { code: 'WHATSAPP_TEMPLATE_NOT_FOUND' },
    });
  });

  it.each([
    ['paused at the provider', { reviewStatus: 'paused' as const }],
    ['missing at the provider', { reviewStatus: 'missing' as const }],
    ['inactive in Akeed', { isActive: false, isDefault: false }],
  ])('refuses a template that is %s', async (_label, change) => {
    const templates = syncedApprovedTemplates().map((template) =>
      template.key === 'cod_confirm.en.direct'
        ? { ...template, ...change }
        : template,
    );
    const { service, sendVerificationTemplate } = setup({ templates });

    const refused = await rejection(
      service.send({
        userId: OPERATOR,
        key: 'cod_confirm.en.direct',
        phone: STAFF_PHONE,
      }),
    );

    expect(refused).toMatchObject({
      status: 409,
      body: { code: 'WHATSAPP_TEMPLATE_NOT_SENDABLE' },
    });
    expect(sendVerificationTemplate).not.toHaveBeenCalled();
  });

  it('sends an active template before the environment has ever synced', async () => {
    const { service, sendVerificationTemplate } = setup({
      templates: seededRegistryTemplates(),
    });

    await service.send({
      userId: OPERATOR,
      key: 'cod_confirm.en.direct',
      phone: STAFF_PHONE,
    });

    expect(sendVerificationTemplate).toHaveBeenCalledTimes(1);
  });

  it('makes a staff member wait between two test sends', async () => {
    const { service, audit, sendVerificationTemplate } = setup({
      latestAllowedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const refused = await rejection(
      service.send({
        userId: OPERATOR,
        key: 'cod_confirm.en.friendly',
        phone: STAFF_PHONE,
      }),
    );

    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_TEST_COOLDOWN',
    });
    expect(refused.body.retry_after_seconds).toBeGreaterThan(0);
    expect(refused.body.retry_after_seconds).toBeLessThanOrEqual(30);
    expect(audit.latestAllowedAt).toHaveBeenCalledWith(
      OPERATOR,
      WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION,
    );
    expect(sendVerificationTemplate).not.toHaveBeenCalled();
  });

  it('stops at the daily limit, counted per staff member over 24 hours', async () => {
    const { service, audit, sendVerificationTemplate } = setup({
      latestAllowedAt: new Date(Date.now() - 3_600_000).toISOString(),
      sentToday: 5,
    });

    const refused = await rejection(
      service.send({
        userId: OPERATOR,
        key: 'cod_confirm.en.friendly',
        phone: STAFF_PHONE,
      }),
    );

    expect(refused).toMatchObject({
      status: 429,
      body: { code: 'WHATSAPP_TEMPLATE_TEST_DAILY_LIMIT' },
    });
    const [userId, action, since] = audit.countAllowedSince.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect([userId, action]).toEqual([
      OPERATOR,
      WHATSAPP_TEMPLATE_TEST_SEND_AUDIT_ACTION,
    ]);
    expect(Date.now() - Date.parse(since)).toBeGreaterThanOrEqual(86_400_000);
    expect(sendVerificationTemplate).not.toHaveBeenCalled();
  });

  it('answers a provider refusal with a neutral code, and audits nothing', async () => {
    const { service, audit } = setup({
      messaging: {
        sendVerificationTemplate: jest
          .fn()
          .mockRejectedValue(
            new Error(`WhatsApp send failed: to=${STAFF_PHONE} code=132001`),
          ),
      },
    });

    const refused = await rejection(
      service.send({
        userId: OPERATOR,
        key: 'cod_confirm.en.direct',
        phone: STAFF_PHONE,
      }),
    );

    expect(refused).toMatchObject({
      status: 502,
      body: { code: 'WHATSAPP_TEMPLATE_TEST_SEND_FAILED' },
    });
    expect(JSON.stringify(refused.body)).not.toContain('132001');
    expect(audit.record).not.toHaveBeenCalled();
    expect(logged()).not.toContain('201001234567');
    expect(logged()).not.toContain('132001');
  });

  describe('through the Meta adapter', () => {
    const baseline = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          '../../../test/fixtures/whatsapp-templates/send-payloads/baseline.json',
        ),
        'utf8',
      ),
    ) as { cases: Record<string, MetaPayload> };

    /**
     * A staff test differs from the recorded merchant test only in who it is
     * sent to, the store name and the ID in its buttons.
     */
    function comparable(payload: MetaPayload): string {
      const copy = JSON.parse(JSON.stringify(payload)) as MetaPayload;
      copy.to = '<to>';
      for (const component of copy.template.components) {
        for (const parameter of component.parameters) {
          if (parameter.parameter_name === 'store') parameter.text = '<store>';
        }
      }
      return JSON.stringify(copy).replace(UUID, '<id>');
    }

    it.each(seededRegistryTemplates().map((template) => template.key))(
      'posts the recorded test payload for %s',
      async (key) => {
        const post = jest.fn(() => of({ data: { messages: [{ id: 'w' }] } }));
        const whatsapp = new WhatsAppService(
          { post } as never,
          {
            get: (name: string) =>
              ({ WA_ACCESS_TOKEN: 'token', WA_PHONE_NUMBER_ID: '1' })[name],
          } as never,
        );
        const { service } = setup({ messaging: whatsapp });

        await service.send({ userId: OPERATOR, key, phone: STAFF_PHONE });

        const [, payload] = post.mock.calls[0] as unknown as [
          string,
          MetaPayload,
        ];
        const variant = key.replace('cod_confirm.', '');
        expect(payload.to).toBe(STAFF_PHONE);
        expect(comparable(payload)).toBe(
          comparable(baseline.cases[`${variant}/test`]),
        );
      },
    );
  });
});
