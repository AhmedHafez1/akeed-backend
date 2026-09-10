import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  RequestMethod,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAccessGuard } from './admin-access.guard';
import { StandaloneBillingController } from './standalone-billing.controller';
import { StandaloneBillingService } from './standalone-billing.service';
import { StandaloneBillingOperationsService } from './standalone-billing-operations.service';
import { TokenValidatorService } from '../auth/services/token-validator.service';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import {
  parseStandaloneBillingOperationsConfig,
  STANDALONE_BILLING_OPERATIONS_CONFIG,
} from '../../shared/config/standalone-billing-operations.config';
import { StandaloneBillingOperatorGuard } from './standalone-billing-operator.guard';

describe('Standalone billing approval staff HTTP boundary', () => {
  let app: INestApplication;
  const staffId = randomUUID();
  const otherStaffId = randomUUID();
  const orgId = randomUUID();
  const previewId = randomUUID();
  const billing = {
    list: jest.fn().mockResolvedValue({ rows: [] }),
    preview: jest.fn().mockResolvedValue({ previewId }),
    apply: jest.fn().mockResolvedValue({ results: [] }),
  };
  const operations = {
    accountDetail: jest.fn().mockResolvedValue({ account: null }),
    previewAdjustment: jest.fn().mockResolvedValue({ previewId }),
    applyAdjustment: jest.fn().mockResolvedValue({ outcome: 'applied' }),
    resolveDispatch: jest.fn().mockResolvedValue({ outcome: 'rejected' }),
    reconcilePurchase: jest.fn().mockResolvedValue({ outcome: 'deferred' }),
    recordProviderAction: jest.fn().mockResolvedValue({ outcome: 'reversed' }),
    previewRepair: jest.fn().mockResolvedValue({ outcome: 'repairable' }),
    applyRepair: jest.fn().mockResolvedValue({ outcome: 'repaired' }),
  };
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StandaloneBillingController],
      providers: [
        AdminAccessGuard,
        StandaloneBillingOperatorGuard,
        { provide: StandaloneBillingService, useValue: billing },
        { provide: StandaloneBillingOperationsService, useValue: operations },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ADMIN_CONTROL_TOWER_ENABLED: 'true',
            [STANDALONE_BILLING_OPERATIONS_CONFIG]:
              parseStandaloneBillingOperationsConfig({
                STANDALONE_BILLING_OPERATIONS_ENABLED: 'true',
                STANDALONE_BILLING_OPERATOR_IDS: staffId,
              }),
          }),
        },
        {
          provide: AdminAccessAuditRepository,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: TokenValidatorService,
          useValue: {
            validateAdminToken: jest.fn((token: string) => {
              if (token !== 'staff-aal2' && token !== 'staff-other')
                throw new ForbiddenException('Staff MFA required');
              return {
                userId: token === 'staff-aal2' ? staffId : otherStaffId,
                role: 'admin',
                aal: 'aal2',
                source: 'supabase',
              };
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());
  it.each([
    'merchant-owner',
    'organization-admin',
    'viewer',
    'shopify',
    'staff-aal1',
  ])('denies %s', async (token) => {
    await http()
      .post('/api/admin/standalone-billing/approvals/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({ previewId, reason: 'Approve' })
      .expect(403);
    expect(billing.apply).not.toHaveBeenCalled();
  });
  it('requires authentication even for discovery', async () => {
    await http().get('/api/admin/standalone-billing/accounts').expect(401);
  });
  it('uses the guard principal and never accepts actor, plan or billing overrides', async () => {
    await http()
      .post('/api/admin/standalone-billing/approvals/apply')
      .set('Authorization', 'Bearer staff-aal2')
      .send({
        previewId,
        reason: '  Approved for credit billing  ',
        userId: randomUUID(),
        billingPlanId: 'business',
        organizationIds: [orgId],
      })
      .expect(201);
    expect(billing.apply).toHaveBeenCalledWith(
      staffId,
      previewId,
      'Approved for credit billing',
    );
  });
  it.each([
    { organizationIds: [] },
    { organizationIds: Array.from({ length: 51 }, () => randomUUID()) },
    { organizationIds: [orgId, orgId] },
    { organizationIds: ['not-a-uuid'] },
  ])('rejects invalid preview selection', async ({ organizationIds }) => {
    await http()
      .post('/api/admin/standalone-billing/approvals/preview')
      .set('Authorization', 'Bearer staff-aal2')
      .send({ organizationIds })
      .expect(400);
    expect(billing.preview).not.toHaveBeenCalled();
  });
  it('accepts an explicit selection and prevents caching', async () => {
    const response = await http()
      .post('/api/admin/standalone-billing/approvals/preview')
      .set('Authorization', 'Bearer staff-aal2')
      .send({ organizationIds: [orgId] })
      .expect(201);
    expect(billing.preview).toHaveBeenCalledWith(staffId, [orgId]);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it.each(['', '   ', 'x'.repeat(501)])(
    'requires a bounded meaningful reason',
    async (reason) => {
      await http()
        .post('/api/admin/standalone-billing/approvals/apply')
        .set('Authorization', 'Bearer staff-aal2')
        .send({ previewId, reason })
        .expect(400);
    },
  );
  it('passes credit filters with the guard principal and rejects unknown ones', async () => {
    await http()
      .get(
        '/api/admin/standalone-billing/accounts?accountStatus=active&balance=debt&reconciliation=required&limit=10',
      )
      .set('Authorization', 'Bearer staff-aal2')
      .expect(200);
    expect(billing.list).toHaveBeenCalledWith(staffId, {
      accountStatus: 'active',
      balance: 'debt',
      reconciliation: 'required',
      limit: 10,
    });
    await http()
      .get('/api/admin/standalone-billing/accounts?balance=rich')
      .set('Authorization', 'Bearer staff-aal2')
      .expect(400);
  });
  it('reads one account by organization id, uncached', async () => {
    const response = await http()
      .get(`/api/admin/standalone-billing/accounts/${orgId}`)
      .set('Authorization', 'Bearer staff-aal2')
      .expect(200);
    expect(operations.accountDetail).toHaveBeenCalledWith(staffId, orgId);
    expect(response.headers['cache-control']).toBe('private, no-store');
    await http()
      .get('/api/admin/standalone-billing/accounts/not-a-uuid')
      .set('Authorization', 'Bearer staff-aal2')
      .expect(400);
  });
  describe('credit adjustments', () => {
    const path = `/api/admin/standalone-billing/accounts/${orgId}/adjustments`;
    const fingerprint = 'a'.repeat(64);

    it('lets any staff member preview, with only a signed nonzero quantity', async () => {
      await http()
        .post(`${path}/preview`)
        .set('Authorization', 'Bearer staff-other')
        .send({ quantity: -25 })
        .expect(201);
      expect(operations.previewAdjustment).toHaveBeenCalledWith(
        otherStaffId,
        orgId,
        -25,
        undefined,
      );
    });

    it.each([
      { quantity: 0 },
      { quantity: 10_001 },
      { quantity: -10_001 },
      { quantity: 1.5 },
    ])('rejects preview body %o', async (body) => {
      await http()
        .post(`${path}/preview`)
        .set('Authorization', 'Bearer staff-aal2')
        .send(body)
        .expect(400);
      expect(operations.previewAdjustment).not.toHaveBeenCalled();
    });

    it('applies only for a named operator, with the idempotency key and request id', async () => {
      await http()
        .post(`${path}/apply`)
        .set('Authorization', 'Bearer staff-other')
        .set('Idempotency-Key', 'adjust-key-1')
        .send({ previewId, fingerprint, reason: 'Goodwill' })
        .expect(403);
      expect(operations.applyAdjustment).not.toHaveBeenCalled();

      const response = await http()
        .post(`${path}/apply`)
        .set('Authorization', 'Bearer staff-aal2')
        .set('Idempotency-Key', 'adjust-key-1')
        .set('X-Request-Id', 'req-7')
        .send({ previewId, fingerprint, reason: '  Goodwill  ' })
        .expect(201);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(operations.applyAdjustment).toHaveBeenCalledWith({
        userId: staffId,
        orgId,
        previewId,
        fingerprint,
        reason: 'Goodwill',
        idempotencyKey: 'adjust-key-1',
        requestId: 'req-7',
      });
    });

    it.each([
      { previewId, fingerprint: 'stale', reason: 'x' },
      { previewId, fingerprint, reason: ' ' },
      { previewId: 'not-a-uuid', fingerprint, reason: 'x' },
    ])('rejects apply body %o', async (body) => {
      await http()
        .post(`${path}/apply`)
        .set('Authorization', 'Bearer staff-aal2')
        .set('Idempotency-Key', 'adjust-key-1')
        .send(body)
        .expect(400);
      expect(operations.applyAdjustment).not.toHaveBeenCalled();
    });

    it('never takes a quantity or balance from the browser', async () => {
      await http()
        .post(`${path}/apply`)
        .set('Authorization', 'Bearer staff-aal2')
        .set('Idempotency-Key', 'adjust-key-1')
        .send({
          previewId,
          fingerprint,
          reason: 'x',
          quantity: 5000,
          postedBalanceAfter: 5000,
          userId: otherStaffId,
        })
        .expect(201);
      const [input] = operations.applyAdjustment.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(Object.keys(input).sort()).toEqual([
        'fingerprint',
        'idempotencyKey',
        'orgId',
        'previewId',
        'reason',
        'requestId',
        'userId',
      ]);
      expect(input.userId).toBe(staffId);
    });
  });

  describe('operator-only writes', () => {
    const dispatchId = randomUUID();
    const reference = 'akd_0123456789abcdef0123456789abcdef';
    const writes = [
      [
        `/api/admin/standalone-billing/accounts/${orgId}/projection-repair/apply`,
        {
          previewId,
          fingerprint: 'b'.repeat(64),
          reason: 'Drift after incident',
        },
      ],
      [
        `/api/admin/standalone-billing/dispatches/${dispatchId}/resolve`,
        { orgId, resolution: 'not_accepted', reason: 'Checked with Meta' },
      ],
      [
        `/api/admin/standalone-billing/purchases/${reference}/reconcile`,
        { orgId, reason: 'Merchant was charged' },
      ],
      [
        `/api/admin/standalone-billing/purchases/${reference}/provider-action`,
        {
          orgId,
          action: 'refund',
          providerReference: 'rf-1',
          amountMinor: 20000,
          currency: 'EGP',
          evidence: 'Paymob refund tab',
          reason: 'Finance confirmed',
        },
      ],
    ] as const;

    it.each(writes)('requires a named operator for %s', async (url, body) => {
      await http()
        .post(url)
        .set('Authorization', 'Bearer staff-other')
        .send(body)
        .expect(403);
      await http()
        .post(url)
        .set('Authorization', 'Bearer staff-aal2')
        .send(body)
        .expect(201);
    });

    it('requires a provider message id to resolve a send as accepted', async () => {
      const url = writes[1][0];
      await http()
        .post(url)
        .set('Authorization', 'Bearer staff-aal2')
        .send({ orgId, resolution: 'accepted', reason: 'Meta says delivered' })
        .expect(400);
      await http()
        .post(url)
        .set('Authorization', 'Bearer staff-aal2')
        .send({
          orgId,
          resolution: 'accepted',
          providerMessageId: 'wamid.HBgLMjAxMDAwMDAwMDAVAgARGBI=',
          evidence: '  Meta support ticket 55  ',
          reason: 'Meta says delivered',
        })
        .expect(201);
      expect(operations.resolveDispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          orgId,
          dispatchId,
          resolution: 'accepted',
          providerMessageId: 'wamid.HBgLMjAxMDAwMDAwMDAVAgARGBI=',
          evidence: 'Meta support ticket 55',
        }),
      );
    });

    it('never forwards a provider message id with a not-accepted resolution', async () => {
      await http()
        .post(writes[1][0])
        .set('Authorization', 'Bearer staff-aal2')
        .send({
          orgId,
          resolution: 'not_accepted',
          providerMessageId: 'wamid.x',
          reason: 'Meta has no record',
        })
        .expect(201);
      expect(operations.resolveDispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ providerMessageId: undefined }),
      );
    });

    it.each([
      { action: 'success' },
      { action: 'grant' },
      { currency: 'egp' },
      { amountMinor: -1 },
      { amountMinor: 1.5 },
      { evidence: '' },
      { orgId: 'not-a-uuid' },
    ])('rejects provider evidence %o', async (override) => {
      await http()
        .post(writes[3][0])
        .set('Authorization', 'Bearer staff-aal2')
        .send({ ...writes[3][1], ...override })
        .expect(400);
      expect(operations.recordProviderAction).not.toHaveBeenCalled();
    });

    it('drops any attempt to assert a payment outcome', async () => {
      await http()
        .post(writes[3][0])
        .set('Authorization', 'Bearer staff-aal2')
        .send({
          ...writes[3][1],
          status: 'successful',
          grant: 100,
          quantity: 100,
        })
        .expect(201);
      const [input] = operations.recordProviderAction.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(input).not.toHaveProperty('status');
      expect(input).not.toHaveProperty('grant');
      expect(input).not.toHaveProperty('quantity');
      await http()
        .post(writes[2][0])
        .set('Authorization', 'Bearer staff-aal2')
        .send({ orgId, reason: 'x', status: 'successful' })
        .expect(201);
      expect(operations.reconcilePurchase).toHaveBeenCalledWith({
        userId: staffId,
        orgId,
        reference,
        reason: 'x',
        requestId: undefined,
      });
    });

    it('rejects a malformed purchase reference or dispatch id', async () => {
      await http()
        .post('/api/admin/standalone-billing/purchases/not-ours/reconcile')
        .set('Authorization', 'Bearer staff-aal2')
        .send({ orgId, reason: 'x' })
        .expect(400);
      await http()
        .post('/api/admin/standalone-billing/dispatches/42/resolve')
        .set('Authorization', 'Bearer staff-aal2')
        .send({ orgId, resolution: 'not_accepted', reason: 'x' })
        .expect(400);
    });
  });

  it('exposes exactly the documented staff routes, and none that marks a payment successful', () => {
    const prototype =
      StandaloneBillingController.prototype as unknown as Record<
        string,
        unknown
      >;
    const routes = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = prototype[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        const route = Reflect.getMetadata(PATH_METADATA, handler) as string;
        return `${RequestMethod[method]} ${route}`;
      })
      .sort();
    expect(routes).toEqual(
      [
        'GET accounts',
        'GET accounts/:orgId',
        'POST accounts/:orgId/adjustments/apply',
        'POST accounts/:orgId/adjustments/preview',
        'POST accounts/:orgId/projection-repair/apply',
        'POST accounts/:orgId/projection-repair/preview',
        'POST approvals/apply',
        'POST approvals/preview',
        'POST dispatches/:dispatchId/resolve',
        'POST purchases/:purchaseRef/provider-action',
        'POST purchases/:purchaseRef/reconcile',
      ].sort(),
    );
    expect(routes.join(' ')).not.toMatch(/success|grant|settle|status/i);
  });
});
