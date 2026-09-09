import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { standaloneCreditBillingConfigService } from '../../../test/contracts/standalone-credit-billing-config';
import { ConfigService } from '@nestjs/config';
import { signPaymobPayload } from '../../infrastructure/spokes/paymob/paymob-hmac';
import { PaymobHmacGuard } from '../../infrastructure/spokes/paymob/paymob-hmac.guard';
import { PaymentCallbackRateLimitGuard } from '../../shared/guards/payment-callback-rate-limit.guard';
import { PaymentCallbackService } from './payment-callback.service';
import { PaymentsCallbackController } from './payments-callback.controller';

const SECRET = 'sandbox-hmac';
const config = standaloneCreditBillingConfigService({
  STANDALONE_CREDIT_BILLING_ENABLED: 'true',
  PAYMOB_MODE: 'test',
  PAYMOB_BASE_URL: 'http://localhost:9000',
  PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
  PAYMOB_RETURN_URL: 'http://localhost:9000',
  PAYMOB_SECRET_KEY: 'sandbox-secret',
  PAYMOB_PUBLIC_KEY: 'sandbox-public',
  PAYMOB_HMAC_SECRET: SECRET,
  PAYMOB_CARD_INTEGRATION_ID: '4001001',
  PAYMOB_WALLET_INTEGRATION_ID: '4001002',
  PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
});

function fixture(name: string): { type: string; obj: Record<string, unknown> } {
  const loaded = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'infrastructure',
        'spokes',
        'paymob',
        'fixtures',
        name,
      ),
      'utf8',
    ),
  ) as { body: { type: string; obj: Record<string, unknown> } };
  return loaded.body;
}

const callbacks = { ingest: jest.fn() };

describe('PaymentsCallbackController', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentsCallbackController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: PaymentCallbackService, useValue: callbacks },
        PaymobHmacGuard,
        PaymentCallbackRateLimitGuard,
      ],
    }).compile();
    // rawBody is what the HMAC is verified against; a reserialized body is no
    // longer the bytes Paymob signed.
    app = moduleRef.createNestApplication<INestApplication<Server>>({
      rawBody: true,
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    callbacks.ingest.mockResolvedValue({
      outcome: 'granted',
      resultCode: 'granted',
    });
  });

  function post(body: unknown, hmac?: string) {
    const payload = body as { obj: Record<string, unknown> };
    const digest = hmac ?? signPaymobPayload(payload.obj, SECRET);
    return request(app.getHttpServer())
      .post(`/api/webhooks/payments/paymob?hmac=${digest}`)
      .set('Content-Type', 'application/json')
      .send(body as object);
  }

  it('answers 200 and grants on a verified success', async () => {
    const response = await post(fixture('transaction.card-success.json'));
    expect(response.status).toBe(200);
    expect(callbacks.ingest).toHaveBeenCalledTimes(1);
  });

  it('passes the provider-neutral event, not the raw payload, to ingestion', async () => {
    await post(fixture('transaction.card-success.json'));
    const [event] = callbacks.ingest.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({
      provider: 'paymob',
      source: 'callback',
      signal: 'success',
      amountMinor: 20000,
      currency: 'EGP',
      mode: 'test',
    });
    expect(event).not.toHaveProperty('obj');
  });

  it.each([
    ['a missing digest', ''],
    ['a malformed digest', 'not-a-digest'],
    ['a digest from another secret', 'wrong'],
  ])('answers 401 to %s and never reaches ingestion', async (_label, kind) => {
    const body = fixture('transaction.card-success.json');
    const digest =
      kind === 'wrong' ? signPaymobPayload(body.obj, 'other-secret') : kind;
    const response = await post(body, digest);
    expect(response.status).toBe(401);
    expect(callbacks.ingest).not.toHaveBeenCalled();
  });

  it('answers 401 to a tampered amount', async () => {
    const body = fixture('transaction.card-success.json');
    const digest = signPaymobPayload(body.obj, SECRET);
    const tampered = { ...body, obj: { ...body.obj, amount_cents: 1 } };
    const response = await post(tampered, digest);
    expect(response.status).toBe(401);
    expect(callbacks.ingest).not.toHaveBeenCalled();
  });

  it('answers 202 to a verified but unsupported event type', async () => {
    // A signable transaction object under a type this integration does not
    // handle. 4xx would have Paymob redelivering it forever with no possible
    // different outcome.
    const body = fixture('transaction.card-success.json');
    const response = await post({ ...body, type: 'TOKEN' });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ outcome: 'unsupported_event_type' });
    expect(callbacks.ingest).not.toHaveBeenCalled();
  });

  it.each([
    ['quarantined', 'unmatched_reference'],
    ['frozen', 'credit_invariant_frozen'],
  ])('answers 202 when ingestion reports %s', async (outcome, resultCode) => {
    callbacks.ingest.mockResolvedValue({ outcome, resultCode });
    const response = await post(fixture('transaction.card-success.json'));
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ outcome: resultCode });
  });

  it.each([
    ['duplicate', 'duplicate_event'],
    ['no_change', 'no_change'],
    ['transitioned', 'transitioned'],
  ])('answers 200 when ingestion reports %s', async (outcome, resultCode) => {
    callbacks.ingest.mockResolvedValue({ outcome, resultCode });
    const response = await post(fixture('transaction.card-success.json'));
    expect(response.status).toBe(200);
  });

  it('answers 5xx on a transient database failure so the provider retries', async () => {
    callbacks.ingest.mockRejectedValue(new Error('connection lost'));
    const response = await post(fixture('transaction.card-success.json'));
    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it('is mounted exactly where PAYMOB_CALLBACK_URL points', () => {
    // Startup validation pins the configured path to this route, so the URL
    // Paymob is configured with and the URL Nest serves cannot drift.
    const billing = config.get<{
      enabled: boolean;
      paymob: { callbackUrl: string };
    }>('standaloneCreditBilling');
    expect(new URL(billing?.paymob.callbackUrl ?? '').pathname).toBe(
      '/api/webhooks/payments/paymob',
    );
  });
});
