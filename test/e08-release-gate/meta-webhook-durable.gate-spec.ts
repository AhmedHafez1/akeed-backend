import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MetaWebhookEventsRepository } from '../../src/infrastructure/database/repositories/meta-webhook-events.repository';
import { MetaTemplateWebhookHandler } from '../../src/infrastructure/spokes/meta/meta-template-webhook.handler';
import { MetaWebhookEventsService } from '../../src/infrastructure/spokes/meta/meta-webhook-events.service';
import { MetaWebhookIntakeInterceptor } from '../../src/infrastructure/spokes/meta/meta-webhook-intake.interceptor';
import { META_WEBHOOK_QUEUE } from '../../src/infrastructure/spokes/meta/meta-webhook-queue.constants';
import { applyMetaWebhookEdge } from '../../src/infrastructure/spokes/meta/meta-webhook.edge';
import { WhatsAppWebhookController } from '../../src/infrastructure/spokes/meta/whatsapp.webhook.controller';
import { WhatsAppWebhookService } from '../../src/infrastructure/spokes/meta/whatsapp.webhook.service';
import { TemplateStatusService } from '../../src/modules/template-registry/template-status.service';
import {
  META_WEBHOOK_CONFIG,
  parseMetaWebhookConfig,
} from '../../src/shared/config/meta-webhook.config';
import { MetaWebhookSignatureGuard } from '../../src/shared/guards/meta-webhook-signature.guard';

/**
 * The durable route over HTTP, in both switch positions.
 *
 * Assembled as `main.ts` assembles it: the body edge, raw body, the app-wide
 * ValidationPipe and the real signature guard, with the real intake, event
 * service and message service. The table is a small in-memory stand-in with
 * the repository's rules; the contract suite proves those on PostgreSQL.
 */
const APP_SECRET = 'synthetic-app-secret';
const VERIFICATION_ID = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f607';

interface Row {
  id: string;
  dedupeHash: string;
  field: string | null;
  payload: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

class InMemoryEvents {
  rows: Row[] = [];
  insertFailure: Error | null = null;

  insertMany(
    events: Omit<Row, 'id' | 'status' | 'attempts' | 'nextAttemptAt'>[],
    nextAttemptAt: string,
  ) {
    if (this.insertFailure) return Promise.reject(this.insertFailure);
    const added = events
      .filter((event, index) => {
        const first = events.findIndex(
          (other) => other.dedupeHash === event.dedupeHash,
        );
        return (
          first === index &&
          !this.rows.some((row) => row.dedupeHash === event.dedupeHash)
        );
      })
      .map((event) => ({
        ...event,
        id: `event-${this.rows.length}-${event.dedupeHash.slice(0, 8)}`,
        status: 'pending',
        attempts: 0,
        nextAttemptAt,
      }));
    this.rows.push(...added);
    return Promise.resolve(added.map(({ id }) => ({ id })));
  }

  claim(id: string) {
    const row = this.rows.find(
      (candidate) => candidate.id === id && candidate.status === 'pending',
    );
    if (!row) return Promise.resolve(undefined);
    row.status = 'processing';
    row.attempts += 1;
    return Promise.resolve({ ...row });
  }

  markSucceeded(id: string) {
    Object.assign(this.find(id), { status: 'succeeded', payload: null });
    return Promise.resolve();
  }

  release(id: string, _attempts: number, error: string, nextAttemptAt: string) {
    Object.assign(this.find(id), {
      status: 'pending',
      lastError: error,
      nextAttemptAt,
    });
    return Promise.resolve();
  }

  markFailed(id: string, _attempts: number, error: string) {
    Object.assign(this.find(id), { status: 'failed', lastError: error });
    return Promise.resolve();
  }

  failExhausted() {
    return Promise.resolve(0);
  }

  claimDue() {
    const due = this.rows.filter(
      (row) =>
        row.status === 'pending' && Date.parse(row.nextAttemptAt) <= Date.now(),
    );
    for (const row of due) {
      row.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    }
    return Promise.resolve(due.map(({ id, attempts }) => ({ id, attempts })));
  }

  private find(id: string): Row {
    return this.rows.find((row) => row.id === id)!;
  }
}

function replyDelivery(wamid = 'wamid.reply') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100000000000001',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '200000000000002' },
              messages: [
                {
                  id: wamid,
                  from: '201001112223',
                  timestamp: '1767268800',
                  type: 'button',
                  button: { payload: `confirm_${VERIFICATION_ID}` },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Passes the guard; fails the DTO: `messages` must be an array. */
const invalidDelivery = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '100000000000001',
      changes: [{ field: 'messages', value: { messages: 'not-a-list' } }],
    },
  ],
};

describe('durable Meta webhook route', () => {
  let app: INestApplication;
  let durable = parseMetaWebhookConfig({});
  const events = new InMemoryEvents();
  const queue = { addBulk: jest.fn() };
  const verificationsRepo = {
    findById: jest.fn(),
    findByWaMessageId: jest.fn(),
    updateStatus: jest.fn(),
  };
  const hub = { finalizeVerification: jest.fn() };
  const templateStatus = { applyEvents: jest.fn() };

  const sign = (body: string) =>
    `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const post = (delivery: unknown, signature?: string) => {
    const body = JSON.stringify(delivery);
    return request(app.getHttpServer() as Server)
      .post('/webhooks/whatsapp')
      .set({
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature ?? sign(body),
      })
      .send(body);
  };
  const service = () => app.get(MetaWebhookEventsService);
  const turn = (value: boolean) => {
    durable = parseMetaWebhookConfig({
      META_WEBHOOK_DURABLE_ENABLED: String(value),
    });
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        MetaWebhookSignatureGuard,
        MetaTemplateWebhookHandler,
        MetaWebhookIntakeInterceptor,
        MetaWebhookEventsService,
        { provide: MetaWebhookEventsRepository, useValue: events },
        { provide: getQueueToken(META_WEBHOOK_QUEUE), useValue: queue },
        { provide: TemplateStatusService, useValue: templateStatus },
        {
          provide: WhatsAppWebhookService,
          useFactory: () =>
            new WhatsAppWebhookService(
              verificationsRepo as never,
              hub as never,
              {} as never,
            ),
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === META_WEBHOOK_CONFIG ? durable : undefined,
            getOrThrow: (key: string) => {
              if (key === 'META_APP_SECRET') return APP_SECRET;
              throw new Error(`Unexpected config ${key}`);
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true, logger: false });
    applyMetaWebhookEdge(app);
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
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    events.rows = [];
    events.insertFailure = null;
    queue.addBulk.mockResolvedValue([]);
    verificationsRepo.findById.mockResolvedValue({
      id: VERIFICATION_ID,
      orgId: 'org-1',
      status: 'sent',
      merchantCanceledAt: null,
    });
    verificationsRepo.updateStatus.mockResolvedValue([{ id: VERIFICATION_ID }]);
    hub.finalizeVerification.mockResolvedValue(undefined);
    templateStatus.applyEvents.mockResolvedValue({});
  });

  afterEach(() => jest.restoreAllMocks());

  describe('switch off', () => {
    beforeEach(() => turn(false));

    it('handles a reply inside the request and stores nothing', async () => {
      await post(replyDelivery()).expect(200).expect({ status: 'success' });

      expect(hub.finalizeVerification).toHaveBeenCalledTimes(1);
      expect(events.rows).toHaveLength(0);
      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    it('answers a body that fails the DTO 400, as today', async () => {
      await post(invalidDelivery).expect(400);

      expect(events.rows).toHaveLength(0);
    });

    it('still answers 200 when a handler fails, as today', async () => {
      verificationsRepo.updateStatus.mockRejectedValue(new Error('database'));

      await post(replyDelivery())
        .expect(200)
        .expect({ status: 'error', message: 'Internal Server Error' });
    });

    it('rejects a bad signature', async () => {
      await post(replyDelivery(), `sha256=${'0'.repeat(64)}`).expect(401);
    });

    it('drains events stored before switching back', async () => {
      turn(true);
      await post(replyDelivery()).expect(200);
      turn(false);

      await service().process(events.rows[0].id);

      expect(hub.finalizeVerification).toHaveBeenCalledTimes(1);
      expect(events.rows[0].status).toBe('succeeded');
    });
  });

  describe('switch on', () => {
    beforeEach(() => turn(true));

    it('stores and answers without touching a handler', async () => {
      await post(replyDelivery()).expect(200).expect({ status: 'success' });

      expect(events.rows).toEqual([
        expect.objectContaining({ field: 'messages', status: 'pending' }),
      ]);
      expect(verificationsRepo.updateStatus).not.toHaveBeenCalled();
      expect(hub.finalizeVerification).not.toHaveBeenCalled();
    });

    it('runs the stored event through the real handlers and clears it', async () => {
      await post(replyDelivery()).expect(200);

      await service().process(events.rows[0].id);

      expect(hub.finalizeVerification).toHaveBeenCalledWith(
        VERIFICATION_ID,
        'confirmed',
      );
      expect(events.rows[0]).toMatchObject({
        status: 'succeeded',
        payload: null,
      });
    });

    it.each([
      ['a wrong signature', `sha256=${'0'.repeat(64)}`],
      ['a signature of another body', 'sha256=' + 'a'.repeat(64)],
      ['an unsigned prefix', 'sha1=abc'],
    ])('rejects %s before storing anything', async (_case, value) => {
      await post(replyDelivery(), value).expect(401);

      expect(events.rows).toHaveLength(0);
    });

    it('rejects a delivery with no signature before storing anything', async () => {
      await request(app.getHttpServer() as Server)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(replyDelivery()))
        .expect(401);

      expect(events.rows).toHaveLength(0);
    });

    it('stores a duplicate delivery once', async () => {
      await post(replyDelivery()).expect(200);
      await post(replyDelivery()).expect(200);

      expect(events.rows).toHaveLength(1);
      expect(queue.addBulk).toHaveBeenCalledTimes(1);
    });

    it('stores a signed POST that fails DTO validation, and the worker fails it', async () => {
      await post(invalidDelivery).expect(200);
      expect(events.rows).toHaveLength(1);

      await expect(service().process(events.rows[0].id)).rejects.toThrow(
        'validation_failed',
      );

      expect(events.rows[0]).toMatchObject({
        status: 'failed',
        lastError: 'validation_failed',
      });
      expect(events.rows[0].payload).toEqual(expect.any(String));
    });

    it('answers 500 when the event cannot be stored', async () => {
      events.insertFailure = new Error('database down');

      const response = await post(replyDelivery()).expect(500);

      expect((response.body as { code?: string }).code).toBe(
        'META_WEBHOOK_NOT_PERSISTED',
      );
      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    it('answers 200 when Redis fails, and the sweep recovers the row', async () => {
      queue.addBulk.mockRejectedValueOnce(new Error('redis down'));

      await post(replyDelivery()).expect(200);
      await new Promise(setImmediate);
      expect(events.rows).toHaveLength(1);

      events.rows[0].nextAttemptAt = new Date(0).toISOString();
      await expect(service().sweep()).resolves.toMatchObject({ queued: 1 });

      expect(queue.addBulk).toHaveBeenCalledTimes(2);
      await service().process(events.rows[0].id);
      expect(hub.finalizeVerification).toHaveBeenCalledTimes(1);
    });

    it('answers while Redis hangs', async () => {
      queue.addBulk.mockReturnValue(new Promise(() => undefined));

      await post(replyDelivery()).expect(200);
    });

    it('retries a failed run and then succeeds', async () => {
      await post(replyDelivery()).expect(200);
      const { id } = events.rows[0];
      hub.finalizeVerification.mockRejectedValueOnce(new Error('database'));

      await expect(service().process(id)).rejects.toThrow('database');
      expect(events.rows[0]).toMatchObject({
        status: 'pending',
        lastError: 'database',
      });
      expect(events.rows[0].payload).toEqual(expect.any(String));

      await service().process(id);
      expect(events.rows[0].status).toBe('succeeded');
    });

    it('accepts a signed body over the app-wide 100 KB limit', async () => {
      const delivery = replyDelivery();
      delivery.entry[0].changes = Array.from({ length: 900 }, (_, index) => ({
        ...replyDelivery(`wamid.${index}`).entry[0].changes[0],
      }));
      expect(JSON.stringify(delivery).length).toBeGreaterThan(100 * 1024);

      await post(delivery).expect(200);

      expect(events.rows).toHaveLength(900);
    });
  });
});
