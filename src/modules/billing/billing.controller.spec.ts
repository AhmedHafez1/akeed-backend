import type { INestApplication, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

const user: AuthenticatedUser = {
  userId: 'user-1',
  source: 'supabase',
  orgId: 'org-1',
  role: 'owner',
};

const billing = {
  readCredits: jest.fn().mockResolvedValue({ availableCredits: 30 }),
  listLedger: jest
    .fn()
    .mockResolvedValue({ items: [], nextCursor: null, limit: 25 }),
  listPurchases: jest
    .fn()
    .mockResolvedValue({ items: [], nextCursor: null, limit: 25 }),
  readPurchase: jest.fn().mockResolvedValue({ reference: 'akd_x' }),
  createPurchase: jest.fn().mockResolvedValue({ reference: 'akd_x' }),
};

const REFERENCE = `akd_${'a'.repeat(32)}`;

describe('BillingController', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: billing }],
    })
      .overrideGuard(DualAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context
            .switchToHttp()
            .getRequest<{ user: AuthenticatedUser }>().user = user;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => jest.clearAllMocks());

  const http = () => request(app.getHttpServer());

  it.each([
    ['/api/billing/credits'],
    ['/api/billing/credits/ledger'],
    ['/api/billing/purchases'],
    [`/api/billing/purchases/${REFERENCE}`],
  ])('answers %s with private, no-store', async (path) => {
    const response = await http().get(path).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('marks the purchase response no-store as well', async () => {
    const response = await http()
      .post('/api/billing/purchases')
      .set('Idempotency-Key', 'idem-key-1')
      .send({ quantity: 100 })
      .expect(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('passes only the guard principal and the body quantity to the service', async () => {
    await http()
      .post('/api/billing/purchases')
      .set('Idempotency-Key', 'idem-key-1')
      .send({ quantity: 150 })
      .expect(201);
    expect(billing.createPurchase).toHaveBeenCalledWith(
      user,
      'idem-key-1',
      150,
    );
  });

  it.each([
    ['a forged price', { quantity: 100, unitPriceMinor: 1 }],
    ['a forged total', { quantity: 100, totalMinor: 1 }],
    ['a forged status', { quantity: 100, status: 'successful' }],
    ['a forged organization', { quantity: 100, orgId: 'org-2' }],
  ])('rejects %s outright rather than stripping it', async (_label, body) => {
    // The global pipe would strip these silently. On a money endpoint the
    // request must fail so the caller learns its value was never used.
    await http()
      .post('/api/billing/purchases')
      .set('Idempotency-Key', 'idem-key-1')
      .send(body)
      .expect(400);
    expect(billing.createPurchase).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing quantity', {}],
    ['a fractional quantity', { quantity: 100.5 }],
    ['a string quantity', { quantity: 'many' }],
  ])('rejects %s', async (_label, body) => {
    await http()
      .post('/api/billing/purchases')
      .set('Idempotency-Key', 'idem-key-1')
      .send(body)
      .expect(400);
    expect(billing.createPurchase).not.toHaveBeenCalled();
  });

  it('reports validation failures with the billing error code', async () => {
    const response = await http()
      .post('/api/billing/purchases')
      .set('Idempotency-Key', 'idem-key-1')
      .send({})
      .expect(400);
    expect(response.body).toMatchObject({
      code: 'BILLING_VALIDATION_FAILED',
      fieldErrors: { quantity: expect.any(String) as string },
    });
  });

  it('forwards a missing Idempotency-Key so the service can name it', async () => {
    await http()
      .post('/api/billing/purchases')
      .send({ quantity: 100 })
      .expect(201);
    expect(billing.createPurchase).toHaveBeenCalledWith(user, undefined, 100);
  });

  it.each(['not-a-reference', 'akd_short', `${REFERENCE}extra`])(
    'rejects the malformed purchase reference %p before any lookup',
    async (reference) => {
      await http().get(`/api/billing/purchases/${reference}`).expect(400);
      expect(billing.readPurchase).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['limit=0', 'limit=0'],
    ['limit=101', 'limit=101'],
    ['an unknown ledger type', 'type=nonsense'],
    ['an unknown query parameter', 'orgId=org-2'],
  ])('rejects %s on the ledger', async (_label, query) => {
    await http().get(`/api/billing/credits/ledger?${query}`).expect(400);
    expect(billing.listLedger).not.toHaveBeenCalled();
  });

  it('accepts a valid ledger page request', async () => {
    await http()
      .get('/api/billing/credits/ledger?limit=10&type=purchase')
      .expect(200);
    expect(billing.listLedger).toHaveBeenCalledWith(user, {
      limit: 10,
      type: 'purchase',
    });
  });
});
