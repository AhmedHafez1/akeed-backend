import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { ShopifyController } from './shopify.controller';
import { ShopifyOrderWebhookService } from './services/shopify-order-webhook.service';
import { ShopifyBillingWebhookService } from './services/shopify-billing-webhook.service';
import { ShopifyGdprWebhookService } from './services/shopify-gdpr-webhook.service';
import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';
import { GlobalExceptionFilter } from '../../../shared/filters/global-exception.filter';
import { WebhookQueueProducer } from '../../../modules/webhook-queue/webhook-queue.producer';
import { WEBHOOK_QUEUE_NAME } from '../../../modules/webhook-queue/webhook-queue.constants';
import { WebhookEventsRepository } from '../../database/repositories/webhook-events.repository';
import { IntegrationsRepository } from '../../database/repositories/integrations.repository';
import { shopifyOrderFixture } from '../../../modules/webhook-queue/normalizers/fixtures/shopify-order.fixture';
import { ShopifyOrderNormalizer } from '../../../modules/webhook-queue/normalizers/shopify-order.normalizer';
import { ShopifyOrderEligibilityStrategy } from './services/shopify-order-eligibility.strategy';
import { PhoneService } from '../../../shared/services/phone.service';

describe('Shopify HTTP raw-body boundary', () => {
  let app: INestApplication;
  const secret = 'synthetic-hmac-secret';
  const queue = { add: jest.fn() };
  const events = { insertIfNew: jest.fn() };
  const integrations = { findByPlatformDomain: jest.fn() };
  const sign = (body: string) =>
    createHmac('sha256', secret).update(body).digest('base64');

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ShopifyController],
      providers: [
        ShopifyHmacGuard,
        ShopifyOrderWebhookService,
        WebhookQueueProducer,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              if (key !== 'SHOPIFY_API_SECRET')
                throw new Error('Unexpected config');
              return secret;
            },
          },
        },
        { provide: getQueueToken(WEBHOOK_QUEUE_NAME), useValue: queue },
        { provide: WebhookEventsRepository, useValue: events },
        { provide: IntegrationsRepository, useValue: integrations },
        { provide: ShopifyBillingWebhookService, useValue: {} },
        { provide: ShopifyGdprWebhookService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true, logger: false });
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
    queue.add.mockResolvedValue({ id: 'job-1' });
    events.insertIfNew.mockResolvedValue({
      id: 'event-1',
      receivedAt: '2026-05-15T00:00:00.000Z',
    });
    integrations.findByPlatformDomain.mockResolvedValue({
      id: 'trusted-int',
      orgId: 'trusted-org',
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  function post(body: string, signature: string | null = sign(body)) {
    const operation = request(app.getHttpServer() as Server)
      .post('/webhooks/shopify/orders-create')
      .set('Content-Type', 'application/json')
      .set('x-shopify-shop-domain', 'synthetic.myshopify.com')
      .set('x-shopify-webhook-id', 'delivery-1')
      .set('x-shopify-topic', 'orders/create');
    if (signature !== null) operation.set('x-shopify-hmac-sha256', signature);
    return operation.send(body);
  }

  it('authenticates exact formatted bytes and preserves supported payload fields through production validation', async () => {
    const raw = shopifyOrderFixture({
      transactions: [{ gateway: 'cod' }],
      orgId: 'forged-org',
      integrationId: 'forged-int',
      name: '#IGNORED',
    });
    const body = JSON.stringify(raw, null, 2) + '\n';
    await post(body).expect(200, { received: true });
    expect(events.insertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'trusted-org',
        integrationId: 'trusted-int',
        rawPayload: {
          id: '12345',
          order_number: '1001',
          phone: '+201001234567',
          customer: { first_name: 'Synthetic', last_name: 'Customer' },
          total_price: '123.40',
          currency: 'EGP',
          payment_gateway_names: ['Cash on Delivery (COD)'],
        },
      }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['one byte', (body: string) => body.replace('12345', '12346')],
    ['whitespace', (body: string) => body + ' '],
  ])('rejects changed %s before ingestion', async (_name, mutate) => {
    const original = JSON.stringify(shopifyOrderFixture());
    await post(mutate(original), sign(original)).expect(401);
    expect(integrations.findByPlatformDomain).not.toHaveBeenCalled();
    expect(events.insertIfNew).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('characterizes transaction-only COD evidence being stripped by the global whitelist before normalization', async () => {
    const payload = shopifyOrderFixture({
      payment_gateway_names: [],
      transactions: [{ gateway: 'COD' }],
    });
    const normalizer = new ShopifyOrderNormalizer(new PhoneService());
    const strategy = new ShopifyOrderEligibilityStrategy();
    expect(
      strategy.evaluateOrderForVerification(
        normalizer.normalizeOrder(payload, 'trusted-int', 'trusted-org')!,
      ).eligible,
    ).toBe(true);
    await post(JSON.stringify(payload)).expect(200);
    const [inserted] = events.insertIfNew.mock.calls[0] as [
      { rawPayload: Record<string, unknown> },
    ];
    expect(inserted.rawPayload).not.toHaveProperty('transactions');
    expect(
      strategy.evaluateOrderForVerification(
        normalizer.normalizeOrder(
          inserted.rawPayload,
          'trusted-int',
          'trusted-org',
        )!,
      ),
    ).toEqual({ eligible: false, reason: 'missing_payment_signal' });
  });

  it.each([null, 'bad-signature', Buffer.alloc(32).toString('base64')])(
    'rejects signature %p before ingestion',
    async (signature) => {
      await post(JSON.stringify(shopifyOrderFixture()), signature).expect(401);
      expect(events.insertIfNew).not.toHaveBeenCalled();
      expect(integrations.findByPlatformDomain).not.toHaveBeenCalled();
    },
  );

  it.each([
    '{"id":',
    JSON.stringify({ id: '1' }),
    JSON.stringify(shopifyOrderFixture({ phone: 42 })),
  ])('rejects malformed JSON or DTO: %s', async (body) => {
    await post(body).expect(400);
    expect(events.insertIfNew).not.toHaveBeenCalled();
  });

  it('returns the duplicate response without enqueueing', async () => {
    events.insertIfNew.mockResolvedValue(null);
    await post(JSON.stringify(shopifyOrderFixture())).expect(200, {
      received: true,
      duplicate: true,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['x-shopify-topic', 'x-shopify-webhook-id'])(
    'acknowledges a missing %s under current routing semantics',
    async (header) => {
      await post(JSON.stringify(shopifyOrderFixture()))
        .unset(header)
        .expect(200, { received: true });
      expect(events.insertIfNew).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey:
            header === 'x-shopify-webhook-id'
              ? (expect.stringMatching(/^shopify-order-12345-\d+$/) as unknown)
              : 'delivery-1',
        }),
      );
    },
  );

  it.each(['x-shopify-topic', 'x-shopify-webhook-id', 'x-shopify-shop-domain'])(
    'forwards malformed routing header %s without dedicated validation',
    async (header) => {
      await post(JSON.stringify(shopifyOrderFixture()))
        .set(header, 'malformed-value')
        .expect(200);
      if (header === 'x-shopify-shop-domain')
        expect(integrations.findByPlatformDomain).toHaveBeenCalledWith(
          'malformed-value',
          'shopify',
        );
      if (header === 'x-shopify-webhook-id')
        expect(events.insertIfNew).toHaveBeenCalledWith(
          expect.objectContaining({ idempotencyKey: 'malformed-value' }),
        );
      expect(queue.add).toHaveBeenCalledTimes(1);
    },
  );

  it('missing domain reaches persistence; simulated NOT NULL rejection returns 500', async () => {
    integrations.findByPlatformDomain.mockResolvedValue(null);
    events.insertIfNew.mockRejectedValue(
      new Error('store_domain cannot be null'),
    );
    await post(JSON.stringify(shopifyOrderFixture()))
      .unset('x-shopify-shop-domain')
      .expect(500);
    expect(integrations.findByPlatformDomain).toHaveBeenCalledWith(
      undefined,
      'shopify',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['database', 'queue'])(
    'returns 500 on %s failure without a successful acknowledgement',
    async (failure) => {
      (failure === 'database'
        ? events.insertIfNew
        : queue.add
      ).mockRejectedValue(new Error('synthetic failure'));
      await post(JSON.stringify(shopifyOrderFixture())).expect(500);
      if (failure === 'database') expect(queue.add).not.toHaveBeenCalled();
    },
  );
});
