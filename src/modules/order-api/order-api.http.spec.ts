import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { IntegrationApiKeysRepository } from '../../infrastructure/database/repositories/integration-api-keys.repository';
import {
  ManualOrderPayloadConflictError,
  type ManualOrderAcceptanceInput,
} from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import { PhoneService } from '../../shared/services/phone.service';
import { IntegrationApiKeyGuard } from '../integration-keys/guards/integration-api-key.guard';
import { generateIntegrationApiKey } from '../integration-keys/integration-api-key.secret';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { StandaloneSendReadinessService } from '../order-ingestion/standalone-send-readiness.service';
import { StandaloneSourceResolver } from '../order-ingestion/standalone-source-resolver';
import { ApiOrderChannelAdapter } from './api-order.channel-adapter';
import { OrderApiController } from './order-api.controller';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SOURCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const keyA = generateIntegrationApiKey();
const keyB = generateIntegrationApiKey();
const revokedKey = generateIntegrationApiKey();
const unknownKey = generateIntegrationApiKey();

function sourceOf(orgId: string, id: string) {
  return {
    id,
    orgId,
    platformType: 'standalone',
    platformStoreUrl: `standalone:${orgId}`,
    isActive: true,
    onboardingStatus: 'completed',
    isAutoVerifyEnabled: true,
  };
}

const order = {
  externalOrderId: '10023',
  customerName: 'Mona Ali',
  customerPhone: '+201001234567',
  totalPrice: '450.00',
  currency: 'EGP',
  paymentMethod: 'cod',
};

/** The error body of a refused request, typed for assertions. */
function errorOf(response: request.Response) {
  return response.body as {
    message: unknown;
    fieldErrors: Record<string, unknown>;
  };
}

const UNIFORM_401 = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'A valid API key is required.',
  code: 'API_KEY_INVALID',
};

/**
 * `POST /api/v1/orders` over real HTTP: the production guard, route pipe,
 * controller, adapter, ingestion service, source resolver and readiness
 * service. Only the repositories and the billing reads behind them are faked,
 * so the test proves what a request can make the acceptance repository write.
 */
describe('POST /api/v1/orders', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;

  const credentials = new Map(
    [
      { key: keyA, id: 'key-a', orgId: ORG_A, integrationId: SOURCE_A },
      { key: keyB, id: 'key-b', orgId: ORG_B, integrationId: SOURCE_B },
      {
        key: revokedKey,
        id: 'key-revoked',
        orgId: ORG_A,
        integrationId: SOURCE_A,
        revokedAt: '2026-10-01T00:00:00.000Z',
      },
    ].map(({ key, ...row }) => [
      key.prefix,
      {
        revokedAt: null,
        ...row,
        prefix: key.prefix,
        keyHash: key.keyHash,
        lastUsedAt: new Date().toISOString(),
      },
    ]),
  );
  const keys = {
    findByPrefixForAuthentication: jest.fn((prefix: string) =>
      Promise.resolve(credentials.get(prefix) ?? null),
    ),
    touchLastUsed: jest.fn(),
  };
  const integrations = { findActiveByOrg: jest.fn() };
  const acceptance = {
    accept: jest.fn<
      Promise<{ eventId: string; order: { id: string }; duplicate: boolean }>,
      [ManualOrderAcceptanceInput]
    >(),
  };
  const dispatcher = { dispatchById: jest.fn<Promise<string>, [string]>() };
  const verifications = { findByOrderId: jest.fn() };
  const creditEligibility = { resolveDenial: jest.fn() };
  const entitlements = {
    accountingModeFor: jest.fn(() => 'periodic_plan'),
    evaluateAccess: jest.fn(),
    hasAvailableSlot: jest.fn(),
  };

  const post = (key = keyA.plaintext, idempotencyKey = 'order-10023') => {
    const call = request(server())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${key}`);
    return idempotencyKey ? call.set('Idempotency-Key', idempotencyKey) : call;
  };

  beforeAll(async () => {
    const readiness = new StandaloneSendReadinessService(
      entitlements as never,
      creditEligibility as never,
      {} as never,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderApiController],
      providers: [
        ApiOrderChannelAdapter,
        PhoneService,
        IntegrationApiKeyGuard,
        { provide: IntegrationApiKeysRepository, useValue: keys },
        {
          provide: StandaloneOrderIngestionService,
          useValue: new StandaloneOrderIngestionService(
            acceptance as never,
            dispatcher as never,
            verifications as never,
            new StandaloneSourceResolver(integrations as never),
            readiness,
          ),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // The app-wide pipe from main.ts, so the route pipe is tested behind it.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    integrations.findActiveByOrg.mockImplementation((orgId: string) =>
      Promise.resolve(
        orgId === ORG_A
          ? [sourceOf(ORG_A, SOURCE_A)]
          : orgId === ORG_B
            ? [sourceOf(ORG_B, SOURCE_B)]
            : [],
      ),
    );
    entitlements.evaluateAccess.mockReturnValue({
      allowed: true,
      reason: null,
    });
    entitlements.hasAvailableSlot.mockResolvedValue({
      available: true,
      reason: null,
      consumedCount: 4,
      includedLimit: 30,
    });
    creditEligibility.resolveDenial.mockResolvedValue(null);
    acceptance.accept.mockResolvedValue({
      eventId: 'event-1',
      order: { id: 'order-1' },
      duplicate: false,
    });
    dispatcher.dispatchById.mockResolvedValue('dispatched');
    verifications.findByOrderId.mockResolvedValue({ id: 'verification-1' });
  });

  const untouched = () => {
    expect(acceptance.accept).not.toHaveBeenCalled();
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  };

  describe('accepted orders', () => {
    it('answers 202 and submits the canonical order to the ingestion command', async () => {
      const response = await post().send(order).expect(202);

      expect(response.body).toEqual({
        orderId: 'order-1',
        verificationId: 'verification-1',
        status: 'accepted',
        duplicate: false,
      });
      const accepted = acceptance.accept.mock.calls[0][0];
      expect(accepted.event).toMatchObject({
        orgId: ORG_A,
        integrationId: SOURCE_A,
        storeDomain: `standalone:${ORG_A}`,
        idempotencyKey: 'api:order-10023',
      });
      expect(accepted.event.rawPayload).toMatchObject({
        ingestionType: 'api',
        order: {
          externalOrderId: 'ref:10023',
          orderNumber: '10023',
          customerPhone: '+201001234567',
          customerName: 'Mona Ali',
          totalPrice: '450.00',
          currency: 'EGP',
          paymentMethod: 'cod',
          codStatus: 'cod',
        },
      });
      expect(accepted.order).toMatchObject({
        orgId: ORG_A,
        integrationId: SOURCE_A,
        externalOrderId: 'ref:10023',
        isTest: false,
      });
      expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
    });

    it('carries the optional order number and extras', async () => {
      await post()
        .send({
          ...order,
          externalOrderId: ' #10023 ',
          orderNumber: 'Web #10023',
          currency: 'egp',
          orderDate: '2026-10-02',
          city: ' Cairo ',
          address: '12 Nile St',
          notes: 'Call first',
        })
        .expect(202);

      expect(acceptance.accept.mock.calls[0][0].event.rawPayload).toMatchObject(
        {
          order: {
            externalOrderId: 'ref:10023',
            orderNumber: 'Web #10023',
            currency: 'EGP',
            orderDate: '2026-10-02',
            city: 'Cairo',
            address: '12 Nile St',
            notes: 'Call first',
          },
        },
      );
    });

    it('replays a duplicate as 202 with duplicate=true', async () => {
      acceptance.accept.mockResolvedValue({
        eventId: 'event-1',
        order: { id: 'order-1' },
        duplicate: true,
      });
      const response = await post().send(order).expect(202);
      expect(response.body).toMatchObject({
        orderId: 'order-1',
        status: 'accepted',
        duplicate: true,
      });
    });

    it('accepts a known non-COD order through the same command; sending is decided downstream', async () => {
      verifications.findByOrderId.mockResolvedValue(undefined);
      const response = await post()
        .send({ ...order, paymentMethod: 'Credit Card' })
        .expect(202);

      // No verification exists for it: the worker's eligibility strategy
      // skips non-COD orders exactly as it does for a manual one.
      expect(response.body).toEqual({
        orderId: 'order-1',
        status: 'accepted',
        duplicate: false,
      });
      expect(
        acceptance.accept.mock.calls[0][0].event.rawPayload.order,
      ).toMatchObject({ paymentMethod: 'credit card', codStatus: 'non_cod' });
    });
  });

  describe('authentication', () => {
    it.each([
      ['no Authorization header', (call: request.Test) => call],
      [
        'a malformed key',
        (call: request.Test) => call.set('Authorization', 'Bearer not-a-key'),
      ],
      [
        'a non-Bearer scheme',
        (call: request.Test) =>
          call.set('Authorization', `Basic ${keyA.plaintext}`),
      ],
      [
        'an unknown key',
        (call: request.Test) =>
          call.set('Authorization', `Bearer ${unknownKey.plaintext}`),
      ],
      [
        'a right prefix with a wrong secret',
        (call: request.Test) =>
          call.set(
            'Authorization',
            `Bearer ${keyA.prefix}_${unknownKey.plaintext.slice(keyA.prefix.length + 1)}`,
          ),
      ],
      [
        'a revoked key',
        (call: request.Test) =>
          call.set('Authorization', `Bearer ${revokedKey.plaintext}`),
      ],
    ])('answers the uniform 401 for %s', async (_case, authorize) => {
      const response = await authorize(
        request(server())
          .post('/api/v1/orders')
          .set('Idempotency-Key', 'order-10023'),
      )
        .send(order)
        .expect(401);

      expect(response.body).toEqual(UNIFORM_401);
      expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
      untouched();
    });

    it('refuses a key in the query string even beside a valid header', async () => {
      const response = await request(server())
        .post(`/api/v1/orders?api_key=${keyA.plaintext}`)
        .set('Authorization', `Bearer ${keyA.plaintext}`)
        .set('Idempotency-Key', 'order-10023')
        .send(order)
        .expect(401);

      expect(response.body).toEqual(UNIFORM_401);
      untouched();
    });

    it('authenticates before it validates', async () => {
      const response = await request(server())
        .post('/api/v1/orders')
        .send({ nonsense: true })
        .expect(401);
      expect(response.body).toEqual(UNIFORM_401);
    });
  });

  describe('tenant isolation', () => {
    it.each(['orgId', 'integrationId', 'platform', 'storeDomain'])(
      'rejects a supplied %s instead of honouring it',
      async (field) => {
        const response = await post()
          .send({ ...order, [field]: field === 'orgId' ? ORG_B : SOURCE_B })
          .expect(400);

        expect(response.body).toMatchObject({ code: 'API_VALIDATION_FAILED' });
        expect(typeof errorOf(response).fieldErrors[field]).toBe('string');
        expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
        untouched();
      },
    );

    it('writes the order of each key into its own organization and source', async () => {
      await post(keyA.plaintext).send(order).expect(202);
      await post(keyB.plaintext).send(order).expect(202);

      const [first, second] = acceptance.accept.mock.calls.map(
        ([input]) => input,
      );
      expect(first.event).toMatchObject({
        orgId: ORG_A,
        integrationId: SOURCE_A,
        storeDomain: `standalone:${ORG_A}`,
      });
      expect(second.event).toMatchObject({
        orgId: ORG_B,
        integrationId: SOURCE_B,
        storeDomain: `standalone:${ORG_B}`,
      });
      expect(JSON.stringify(first)).not.toContain(ORG_B);
      expect(JSON.stringify(first)).not.toContain(SOURCE_B);
      expect(JSON.stringify(second)).not.toContain(ORG_A);
      expect(JSON.stringify(second)).not.toContain(SOURCE_A);
    });

    it('never stores the credential with the order', async () => {
      await post().send(order).expect(202);
      const stored = JSON.stringify(acceptance.accept.mock.calls[0][0]);
      expect(stored).not.toContain('key-a');
      expect(stored).not.toContain(keyA.prefix);
    });
  });

  describe('validation', () => {
    it.each([
      { key: undefined, label: 'a missing Idempotency-Key' },
      { key: 'short', label: 'a short Idempotency-Key' },
      { key: 'invalid key spaces', label: 'an Idempotency-Key with spaces' },
    ])('answers API_VALIDATION_FAILED for $label', async ({ key }) => {
      const call = request(server())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${keyA.plaintext}`);
      const response = await (key ? call.set('Idempotency-Key', key) : call)
        .send(order)
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'API_VALIDATION_FAILED',
      });
      expect(typeof errorOf(response).fieldErrors.idempotencyKey).toBe(
        'string',
      );
      untouched();
    });

    it.each<[string, Record<string, unknown>, string]>([
      [
        'a missing externalOrderId',
        { externalOrderId: undefined },
        'externalOrderId',
      ],
      [
        'an empty externalOrderId',
        { externalOrderId: '   ' },
        'externalOrderId',
      ],
      [
        'an externalOrderId with no content',
        { externalOrderId: '##' },
        'externalOrderId',
      ],
      [
        'a long externalOrderId',
        { externalOrderId: 'x'.repeat(101) },
        'externalOrderId',
      ],
      [
        'a numeric externalOrderId',
        { externalOrderId: 10023 },
        'externalOrderId',
      ],
      ['a missing customerName', { customerName: undefined }, 'customerName'],
      [
        'a long customerName',
        { customerName: 'x'.repeat(256) },
        'customerName',
      ],
      [
        'a missing customerPhone',
        { customerPhone: undefined },
        'customerPhone',
      ],
      ['a short customerPhone', { customerPhone: '12345' }, 'customerPhone'],
      [
        'an unreadable customerPhone',
        { customerPhone: '0000000000' },
        'customerPhone',
      ],
      ['a numeric totalPrice', { totalPrice: 450 }, 'totalPrice'],
      ['a zero totalPrice', { totalPrice: '0.00' }, 'totalPrice'],
      ['a negative totalPrice', { totalPrice: '-5' }, 'totalPrice'],
      ['a too-precise totalPrice', { totalPrice: '1.999' }, 'totalPrice'],
      ['an unsupported currency', { currency: 'XYZ' }, 'currency'],
      ['a missing currency', { currency: undefined }, 'currency'],
      [
        'a missing paymentMethod',
        { paymentMethod: undefined },
        'paymentMethod',
      ],
      ['an empty paymentMethod', { paymentMethod: ' ' }, 'paymentMethod'],
      [
        'a long paymentMethod',
        { paymentMethod: 'x'.repeat(101) },
        'paymentMethod',
      ],
      ['a long orderNumber', { orderNumber: 'x'.repeat(101) }, 'orderNumber'],
      [
        'a timestamp orderDate',
        { orderDate: '2026-10-02T10:00:00Z' },
        'orderDate',
      ],
      ['an impossible orderDate', { orderDate: '2026-02-30' }, 'orderDate'],
      ['a long city', { city: 'x'.repeat(1001) }, 'city'],
      ['a non-text address', { address: { line: 1 } }, 'address'],
      ['a long notes', { notes: 'x'.repeat(1001) }, 'notes'],
      ['an unknown field', { discountCode: 'SAVE' }, 'discountCode'],
    ])('answers API_VALIDATION_FAILED for %s', async (_case, patch, field) => {
      const response = await post()
        .send({ ...order, ...patch })
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Order validation failed.',
        code: 'API_VALIDATION_FAILED',
      });
      expect(typeof errorOf(response).fieldErrors[field]).toBe('string');
      expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
      untouched();
    });
  });

  describe('unready sources', () => {
    it.each<[string, () => void, number, string]>([
      [
        'no active source',
        () => integrations.findActiveByOrg.mockResolvedValue([]),
        409,
        'API_SOURCE_UNAVAILABLE',
      ],
      [
        'a key of a source that is no longer the active one',
        () =>
          integrations.findActiveByOrg.mockResolvedValue([
            sourceOf(ORG_A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
          ]),
        409,
        'API_SOURCE_UNAVAILABLE',
      ],
      [
        'a second active source',
        () =>
          integrations.findActiveByOrg.mockResolvedValue([
            sourceOf(ORG_A, SOURCE_A),
            sourceOf(ORG_A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
          ]),
        409,
        'API_SOURCE_UNAVAILABLE',
      ],
      [
        'a non-Standalone source',
        () =>
          integrations.findActiveByOrg.mockResolvedValue([
            { ...sourceOf(ORG_A, SOURCE_A), platformType: 'shopify' },
          ]),
        403,
        'API_SOURCE_UNAVAILABLE',
      ],
      [
        'unfinished onboarding',
        () =>
          integrations.findActiveByOrg.mockResolvedValue([
            { ...sourceOf(ORG_A, SOURCE_A), onboardingStatus: 'pending' },
          ]),
        409,
        'API_SETUP_INCOMPLETE',
      ],
      [
        'no active entitlement',
        () =>
          entitlements.evaluateAccess.mockReturnValue({
            allowed: false,
            reason: 'billing_not_active',
          }),
        409,
        'API_ENTITLEMENT_REQUIRED',
      ],
      [
        'automatic verification switched off',
        () =>
          integrations.findActiveByOrg.mockResolvedValue([
            { ...sourceOf(ORG_A, SOURCE_A), isAutoVerifyEnabled: false },
          ]),
        409,
        'API_AUTO_VERIFY_DISABLED',
      ],
      [
        'a used-up plan',
        () =>
          entitlements.hasAvailableSlot.mockResolvedValue({
            available: false,
            reason: 'plan_limit_reached',
            consumedCount: 30,
            includedLimit: 30,
          }),
        409,
        'API_PLAN_LIMIT_REACHED',
      ],
      [
        'a suspended credit account (E04.5 code unchanged)',
        () =>
          creditEligibility.resolveDenial.mockResolvedValue(
            'CREDIT_ACCOUNT_SUSPENDED',
          ),
        409,
        'CREDIT_ACCOUNT_SUSPENDED',
      ],
      [
        'no credits left (E04.5 code unchanged)',
        () =>
          creditEligibility.resolveDenial.mockResolvedValue(
            'INSUFFICIENT_CREDITS',
          ),
        409,
        'INSUFFICIENT_CREDITS',
      ],
    ])(
      'refuses %s with no business effect',
      async (_case, arrange, status, code) => {
        arrange();
        const response = await post().send(order).expect(status);

        expect(response.body).toMatchObject({ statusCode: status, code });
        expect(typeof errorOf(response).message).toBe('string');
        untouched();
      },
    );
  });

  describe('ingestion outcomes', () => {
    it('answers 409 when the key was used with different order data', async () => {
      acceptance.accept.mockRejectedValue(
        new ManualOrderPayloadConflictError(),
      );
      const response = await post().send(order).expect(409);
      expect(response.body).toMatchObject({
        code: 'API_ORDER_IDEMPOTENCY_CONFLICT',
      });
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
    });

    it('answers 503 without leaking the cause when nothing was stored', async () => {
      acceptance.accept.mockRejectedValue(
        new Error('connection to 10.0.0.5:5432 refused'),
      );
      const response = await post().send(order).expect(503);
      expect(response.body).toMatchObject({
        code: 'API_ORDER_ACCEPTANCE_FAILED',
      });
      expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
    });

    it.each(['failed', 'not_claimed'])(
      'answers 503 when the stored order could not be queued (%s)',
      async (outcome) => {
        dispatcher.dispatchById.mockResolvedValue(outcome);
        const response = await post().send(order).expect(503);
        expect(response.body).toMatchObject({
          code: 'API_ORDER_DISPATCH_FAILED',
        });
      },
    );
  });
});
