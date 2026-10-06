import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MetaTemplateWebhookHandler } from '../../src/infrastructure/spokes/meta/meta-template-webhook.handler';
import { WhatsAppWebhookController } from '../../src/infrastructure/spokes/meta/whatsapp.webhook.controller';
import { WhatsAppWebhookService } from '../../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { TemplateAlertService } from '../../src/modules/template-registry/template-alert.service';
import { TemplateStatusService } from '../../src/modules/template-registry/template-status.service';
import { InMemoryTemplateSyncRepository } from '../../src/modules/template-registry/testing/in-memory-template-sync.repository';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../src/shared/config/whatsapp-template.config';
import { MetaWebhookSignatureGuard } from '../../src/shared/guards/meta-webhook-signature.guard';
import { isSendableReviewStatus } from '../../src/shared/messaging/template-provider.types';

/**
 * US-08-08 criterion 4: the webhook replay and ordering matrix, over HTTP.
 *
 * The route is assembled as `main.ts` assembles it (raw body, the app-wide
 * ValidationPipe, the real signature guard), with the real template handler,
 * the real event rules and the real message service. Only the tables behind
 * them are in memory. The payloads are the committed fixtures, which are
 * built from the contract record (4.8.4 to 4.8.14).
 */
const APP_SECRET = 'synthetic-app-secret';
const ACCOUNT_ID = '100000000000001';
const ARABIC_DEFAULT = 'cod_confirm.ar.standard';
const VERIFICATION_ID = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f607';
const FIXTURES = resolve(__dirname, '../fixtures/whatsapp-templates/webhooks');

interface Change {
  field: string;
  value: Record<string, unknown>;
}
interface Delivery {
  object: string;
  entry: { id: string; time: number; changes: Change[] }[];
}

function fixture(name: string): Delivery {
  return (
    JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as {
      payload: Delivery;
    }
  ).payload;
}

function at(delivery: Delivery, time: number): Delivery {
  return { ...delivery, entry: [{ ...delivery.entry[0], time }] };
}

/** A button tap and a delivery receipt, as the `messages` field carries them. */
function messagesChange(): Change {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      messages: [
        {
          id: 'wamid.reply',
          from: '201001112223',
          timestamp: '1767268800',
          type: 'button',
          button: { payload: `confirm_${VERIFICATION_ID}`, text: 'Confirm' },
          context: { id: 'wamid.template' },
        },
      ],
      statuses: [
        {
          id: 'wamid.other-template',
          status: 'delivered',
          timestamp: '1767268801',
          recipient_id: '201001112223',
        },
      ],
    },
  };
}

describe('US-08-08 webhook replay and ordering matrix', () => {
  let app: INestApplication;
  let repository: InMemoryTemplateSyncRepository;
  let lines: string[];
  const producer = { requestSyncSoon: jest.fn().mockResolvedValue(undefined) };
  const registry = { listTemplates: jest.fn(), invalidate: jest.fn() };
  const verificationsRepo = {
    findById: jest.fn(),
    findByWaMessageId: jest.fn(),
    updateStatus: jest.fn(),
    updateStatusByWamid: jest.fn(),
  };
  const hub = { finalizeVerification: jest.fn() };
  const messageDispatches = {
    findByProviderMessageId: jest.fn(),
    resolveOrParkReceipt: jest.fn(),
    recordProviderStatus: jest.fn(),
  };
  const templates = parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
    WA_BUSINESS_ACCOUNT_ID: ACCOUNT_ID,
  });

  const sign = (body: string) =>
    `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const post = (delivery: Delivery, signature?: string) => {
    const body = JSON.stringify(delivery);
    return request(app.getHttpServer() as Server)
      .post('/webhooks/whatsapp')
      .set({
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature ?? sign(body),
      })
      .send(body);
  };
  const row = () => repository.row(ARABIC_DEFAULT);
  const outcomes = () => repository.events.map((event) => event.outcome);
  /** Everything the message path did, in order. */
  const messagePathCalls = () =>
    JSON.stringify(
      [
        verificationsRepo.findById,
        verificationsRepo.findByWaMessageId,
        verificationsRepo.updateStatus,
        verificationsRepo.updateStatusByWamid,
        hub.finalizeVerification,
        messageDispatches.findByProviderMessageId,
        messageDispatches.resolveOrParkReceipt,
        messageDispatches.recordProviderStatus,
      ].map((mock) => mock.mock.calls as unknown[]),
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        MetaWebhookSignatureGuard,
        MetaTemplateWebhookHandler,
        {
          provide: WhatsAppWebhookService,
          useFactory: () =>
            new WhatsAppWebhookService(
              verificationsRepo as never,
              hub as never,
              messageDispatches as never,
            ),
        },
        {
          provide: TemplateStatusService,
          // Reads `repository` on every call, so each test gets a fresh one.
          useFactory: () => ({
            applyEvents: (events: never) =>
              new TemplateStatusService(
                repository as never,
                registry,
                new TemplateAlertService(repository as never),
                producer as never,
              ).applyEvents(events),
          }),
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'META_APP_SECRET'
                ? APP_SECRET
                : key === WHATSAPP_TEMPLATE_CONFIG
                  ? templates
                  : undefined,
            getOrThrow: (key: string) => {
              if (key === 'META_APP_SECRET') return APP_SECRET;
              throw new Error(`Unexpected config ${key}`);
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true, logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new InMemoryTemplateSyncRepository();
    verificationsRepo.findById.mockResolvedValue({
      id: VERIFICATION_ID,
      orgId: 'org-1',
      status: 'sent',
      merchantCanceledAt: null,
    });
    verificationsRepo.findByWaMessageId.mockResolvedValue(undefined);
    verificationsRepo.updateStatus.mockResolvedValue([{ id: VERIFICATION_ID }]);
    verificationsRepo.updateStatusByWamid.mockResolvedValue([]);
    hub.finalizeVerification.mockResolvedValue(undefined);
    messageDispatches.findByProviderMessageId.mockResolvedValue(undefined);
    messageDispatches.resolveOrParkReceipt.mockResolvedValue({
      outcome: 'verification',
    });
    messageDispatches.recordProviderStatus.mockResolvedValue(undefined);
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(String(args[0]));
        });
    }
  });

  afterEach(() => {
    const logged = lines.join('\n');
    jest.restoreAllMocks();
    expect(logged).not.toContain(APP_SECRET);
  });

  describe('duplicates (record 4.8.13 and 4.8.14)', () => {
    it.each([
      ['status', 'status-paused', { reviewStatus: 'paused' }],
      ['quality', 'quality-red', { quality: 'low' }],
      ['category', 'category-completed', { category: 'marketing' }],
    ])(
      'applies a %s event once however often Meta redelivers it',
      async (_field, name, expected) => {
        const delivery = fixture(name);

        await post(delivery).expect(200);
        const afterFirst = JSON.stringify(repository.rows);
        await post(delivery).expect(200);
        await post(delivery).expect(200);

        expect(row()).toMatchObject(expected);
        expect(JSON.stringify(repository.rows)).toBe(afterFirst);
        expect(outcomes()).toEqual(['applied']);
        // Only the first delivery asks for a sync.
        expect(producer.requestSyncSoon).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('order (record 4.8.15, UNKNOWN, and its worst-case rule)', () => {
    it('ignores an older status that arrives after a newer one, and stores it as stale', async () => {
      await post(at(fixture('status-paused'), 2_000)).expect(200);
      await post(at(fixture('status-approved'), 1_000)).expect(200);

      expect(row().reviewStatus).toBe('paused');
      expect(outcomes()).toEqual(['applied', 'stale']);
    });

    it('applies the same two events in their real order', async () => {
      await post(at(fixture('status-approved'), 1_000)).expect(200);
      await post(at(fixture('status-paused'), 2_000)).expect(200);

      expect(row().reviewStatus).toBe('paused');
      expect(outcomes()).toEqual(['applied', 'applied']);
    });

    it('orders each field on its own: an old quality event does not undo a newer status', async () => {
      await post(at(fixture('status-paused'), 2_000)).expect(200);
      await post(at(fixture('quality-red'), 1_000)).expect(200);

      expect(row()).toMatchObject({ reviewStatus: 'paused', quality: 'low' });
    });

    it('does not order two different events of the same second by guesswork: it keeps the first and asks for a sync', async () => {
      await post(at(fixture('status-paused'), 2_000)).expect(200);
      await post(at(fixture('status-approved'), 2_000)).expect(200);

      expect(row().reviewStatus).toBe('paused');
      expect(outcomes()).toEqual(['applied', 'conflict']);
      expect(producer.requestSyncSoon).toHaveBeenCalledTimes(2);
    });
  });

  describe('unknown values (record 4.8.17, UNKNOWN, and 4.2.11)', () => {
    it('maps a status Meta has not documented to unknown, which is not sendable, and asks for a sync', async () => {
      const delivery = fixture('status-approved');
      delivery.entry[0].changes[0].value.event = 'A_STATUS_FROM_THE_FUTURE';

      await post(delivery).expect(200);

      expect(row().reviewStatus).toBe('unknown');
      expect(isSendableReviewStatus(row().reviewStatus)).toBe(false);
      expect(producer.requestSyncSoon).toHaveBeenCalledTimes(1);
    });

    it.each(['status-flagged', 'status-locked', 'status-reinstated'])(
      'keeps %s not sendable until a sync reads the list',
      async (name) => {
        await post(fixture(name)).expect(200);

        expect(isSendableReviewStatus(row().reviewStatus)).toBe(false);
      },
    );
  });

  describe('signature (record 4.8.5)', () => {
    it.each([
      ['a wrong signature', `sha256=${'0'.repeat(64)}`],
      ['a signature of another body', sign('{"object":"other"}')],
      ['an unsigned prefix', 'sha1=abc'],
    ])('rejects %s before anything reads the body', async (_case, value) => {
      await post(fixture('status-paused'), value).expect(401);

      expect(repository.events).toHaveLength(0);
      expect(row().reviewStatus).toBeNull();
      expect(messagePathCalls()).toBe(JSON.stringify(Array(8).fill([])));
    });

    it('rejects a delivery with no signature header', async () => {
      await request(app.getHttpServer() as Server)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(fixture('status-paused')))
        .expect(401);

      expect(repository.events).toHaveLength(0);
    });
  });

  describe('a template event interleaved with replies and receipts', () => {
    function delivery(changes: Change[]): Delivery {
      return {
        object: 'whatsapp_business_account',
        entry: [{ id: ACCOUNT_ID, time: 1767268980, changes }],
      };
    }
    const templateChange = () => fixture('status-paused').entry[0].changes[0];

    it('handles the reply and the receipt exactly as it does without the template event', async () => {
      await post(delivery([messagesChange()])).expect(200);
      const alone = messagePathCalls();
      expect(hub.finalizeVerification).toHaveBeenCalledTimes(1);
      jest.clearAllMocks();

      await post(
        delivery([templateChange(), messagesChange(), templateChange()]),
      ).expect(200);

      expect(messagePathCalls()).toBe(alone);
    });

    it('applies the template event exactly as it does without the reply and the receipt', async () => {
      await post(delivery([templateChange()])).expect(200);
      const alone = JSON.stringify(repository.rows);
      repository = new InMemoryTemplateSyncRepository();

      await post(delivery([messagesChange(), templateChange()])).expect(200);

      expect(JSON.stringify(repository.rows)).toBe(alone);
      expect(row().reviewStatus).toBe('paused');
      expect(outcomes()).toEqual(['applied']);
    });

    it('still answers 200 and still handles the reply when the registry write fails', async () => {
      repository.recordEvent = (() =>
        Promise.reject(new Error('database unavailable'))) as never;

      await post(delivery([messagesChange(), templateChange()])).expect(200);

      expect(hub.finalizeVerification).toHaveBeenCalledTimes(1);
    });

    it('drops a template event from another WhatsApp Business Account and still handles the reply', async () => {
      const foreign = delivery([messagesChange(), templateChange()]);
      foreign.entry[0].id = '999999999999999';

      await post(foreign).expect(200);

      expect(repository.events).toHaveLength(0);
      expect(row().reviewStatus).toBeNull();
      expect(hub.finalizeVerification).toHaveBeenCalledTimes(1);
    });
  });
});
