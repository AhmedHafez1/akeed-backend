import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { WooCommerceConnectionsRepository } from '../../database/repositories/woocommerce-connections.repository';
import { OrdersRepository } from '../../database/repositories/orders.repository';
import { WebhookEventsRepository } from '../../database/repositories/webhook-events.repository';
import { WebhookQueueProducer } from '../../../modules/webhook-queue/webhook-queue.producer';
import {
  WOOCOMMERCE_CONFIG,
  WOOCOMMERCE_WEBHOOK_PATH,
} from '../../../shared/config/woocommerce.config';
import { GlobalExceptionFilter } from '../../../shared/filters/global-exception.filter';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import {
  pingFixture,
  placedCodFixture,
} from '../../../../test/fixtures/woocommerce/load';
import { hashInstallToken } from '../../../shared/commerce/install-token';
import { WooCommerceWebhookController } from './woocommerce-webhook.controller';
import {
  applyWooCommerceWebhookEdge,
  WOOCOMMERCE_WEBHOOK_MAX_BODY_BYTES,
} from './woocommerce-webhook.edge';
import { WooCommerceWebhookService } from './woocommerce-webhook.service';

/**
 * The delivery route as `main.ts` assembles it: the raw-body edge, the
 * app-wide ValidationPipe and the exception filter in front of the real
 * service. Only the database and the queue are fakes.
 */
describe('WooCommerce delivery HTTP raw-body boundary', () => {
  let app: INestApplication;
  const ENCRYPTION_KEY = 'k'.repeat(32);
  const ORG_ID = '11111111-1111-4111-8111-111111111111';
  const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222';
  const TOKEN = randomBytes(32).toString('base64url');
  const SECRET = randomBytes(32).toString('base64url');
  const settings = { ingestionEnabled: true };
  const connections = {
    isKnownWebhookToken: jest.fn(),
    findByWebhookTokenHash: jest.fn(),
    recordRejectedDelivery: jest.fn(),
  };
  const events = { findBySourceAndIdempotency: jest.fn() };
  const orders = { findBySourceExternalId: jest.fn() };
  const producer = { ingest: jest.fn() };

  const sign = (body: string) =>
    createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
  const server = () => app.getHttpServer() as Server;
  const url = (token = TOKEN) => `${WOOCOMMERCE_WEBHOOK_PATH}/${token}`;

  function post(body: string, headers: Record<string, string> = {}) {
    return request(server())
      .post(url())
      .set({
        'Content-Type': 'application/json',
        'X-WC-Webhook-Topic': 'order.created',
        'X-WC-Webhook-Source': 'https://example.com/',
        'X-WC-Webhook-ID': '9001',
        'X-WC-Webhook-Delivery-ID': 'synthetic-delivery-0002',
        'X-WC-Webhook-Signature': sign(body),
        ...headers,
      })
      .send(body);
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WooCommerceWebhookController],
      providers: [
        WooCommerceWebhookService,
        { provide: WooCommerceConnectionsRepository, useValue: connections },
        { provide: WebhookEventsRepository, useValue: events },
        { provide: OrdersRepository, useValue: orders },
        { provide: WebhookQueueProducer, useValue: producer },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === WOOCOMMERCE_CONFIG ? settings : undefined,
            getOrThrow: (key: string) => {
              if (key !== 'SHOPIFY_TOKEN_ENCRYPTION_KEY')
                throw new Error('Unexpected config');
              return ENCRYPTION_KEY;
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true, logger: false });
    applyWooCommerceWebhookEdge(app);
    app.useGlobalFilters(new GlobalExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    settings.ingestionEnabled = true;
    connections.isKnownWebhookToken.mockResolvedValue(true);
    connections.findByWebhookTokenHash.mockResolvedValue({
      integrationId: INTEGRATION_ID,
      orgId: ORG_ID,
      storeUrl: 'https://example.com',
      webhookSecretEncrypted: encryptToken(SECRET, ENCRYPTION_KEY),
      connectedAt: '2025-12-31T00:00:00.000Z',
    });
    connections.recordRejectedDelivery.mockResolvedValue(undefined);
    events.findBySourceAndIdempotency.mockResolvedValue(undefined);
    producer.ingest.mockResolvedValue({ enqueued: true });
  });

  afterAll(async () => {
    await app.close();
  });

  it('verifies the signature over the bytes as they arrived and answers 200 with no body', async () => {
    // Spacing and key order a re-serialized body would not reproduce.
    const body = `{ "billing" : ${JSON.stringify(placedCodFixture().payload.billing)},\n  "status":"processing", "payment_method":"cod", "total":"450.00",\n "currency":"EGP", "date_created_gmt":"2026-01-01T10:00:00", "id" : 1001 }`;

    const response = await post(body);

    expect(response.status).toBe(200);
    expect(response.text).toBe('');
    expect(connections.findByWebhookTokenHash).toHaveBeenCalledWith(
      hashInstallToken(TOKEN),
    );
    expect(producer.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'woocommerce',
        storeDomain: `woocommerce:${ORG_ID}`,
        jobType: 'order.create',
        idempotencyKey: `order.create:${INTEGRATION_ID}:1001`,
        rawPayload: expect.objectContaining({
          topic: 'order.created',
          webhookId: '9001',
          deliveryId: 'synthetic-delivery-0002',
        }) as unknown,
      }),
    );
  });

  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'application/octet-stream',
  ])('reads a signed order sent as %s', async (contentType) => {
    const body = JSON.stringify(placedCodFixture().payload);

    const response = await post(body, { 'Content-Type': contentType });

    expect(response.status).toBe(200);
    expect(producer.ingest).toHaveBeenCalledTimes(1);
  });

  it('answers one 401 for a wrong signature and stores nothing', async () => {
    const body = JSON.stringify(placedCodFixture().payload);

    const response = await post(body, {
      'X-WC-Webhook-Signature': sign(`${body} `),
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
    });
    expect(connections.recordRejectedDelivery).toHaveBeenCalledTimes(1);
    expect(producer.ingest).not.toHaveBeenCalled();
  });

  it('answers the ping 200 whatever its body is', async () => {
    for (const [contentType, body] of [
      ['application/x-www-form-urlencoded', pingFixture()],
      ['application/json', '{"webhook_id":'],
      ['text/plain', 'ping'],
    ]) {
      const response = await request(server())
        .post(url())
        .set('Content-Type', contentType)
        .send(body);

      expect(response.status).toBe(200);
      expect(response.text).toBe('');
    }
    const bare = await request(server()).post(url());

    expect(bare.status).toBe(200);
    expect(producer.ingest).not.toHaveBeenCalled();
    expect(connections.recordRejectedDelivery).not.toHaveBeenCalled();
  });

  it('answers 404 to an order delivery while ingestion is off', async () => {
    settings.ingestionEnabled = false;

    const response = await post(JSON.stringify(placedCodFixture().payload));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE',
    });
    expect(connections.findByWebhookTokenHash).not.toHaveBeenCalled();
  });

  it('answers 5xx when the event could not be written', async () => {
    producer.ingest.mockRejectedValue(new Error('connection terminated'));

    const response = await post(JSON.stringify(placedCodFixture().payload));

    expect(response.status).toBe(500);
    // The store gets no detail of the failure.
    expect(JSON.stringify(response.body)).not.toContain('connection');
  });

  it('refuses a body over the limit before the service runs', async () => {
    const response = await request(server())
      .post(url())
      .set('Content-Type', 'application/json')
      .set('X-WC-Webhook-Topic', 'order.created')
      .send(Buffer.alloc(WOOCOMMERCE_WEBHOOK_MAX_BODY_BYTES + 1, 0x61));

    expect(response.status).toBe(413);
    expect(connections.findByWebhookTokenHash).not.toHaveBeenCalled();
  });
});
