import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Server } from 'node:http';
import request from 'supertest';
import { IntegrationApiKeysRepository } from '../../infrastructure/database/repositories/integration-api-keys.repository';
import {
  ManualOrderIdentityConflictError,
  ManualOrderPayloadConflictError,
  type ManualOrderAcceptanceInput,
} from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import {
  ORDER_API_CONFIG,
  type OrderApiConfig,
} from '../../shared/config/order-api.config';
import { PhoneService } from '../../shared/services/phone.service';
import { IntegrationApiKeyGuard } from '../integration-keys/guards/integration-api-key.guard';
import { generateIntegrationApiKey } from '../integration-keys/integration-api-key.secret';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { StandaloneSendReadinessService } from '../order-ingestion/standalone-send-readiness.service';
import { StandaloneSourceResolver } from '../order-ingestion/standalone-source-resolver';
import { ApiOrderChannelAdapter } from './api-order.channel-adapter';
import {
  OrderApiIngressThrottleGuard,
  OrderApiThrottleGuard,
} from './edge/order-api-throttle.guard';
import { applyOrderApiEdge } from './edge/order-api.edge';
import { OrderApiController } from './order-api.controller';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SOURCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const keyA = generateIntegrationApiKey();
/** A second key of the same integration, as after a rotation. */
const keyARotated = generateIntegrationApiKey();
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
  code: 'API_KEY_INVALID',
  message: 'A valid API key is required.',
  correlationId: expect.any(String) as unknown,
};

/** Limits no test of the request path can reach by accident. */
const ROOMY_LIMITS: OrderApiConfig = {
  perIntegrationPerMinute: 5_000,
  globalPerMinute: 50_000,
  preAuthPerIpPerMinute: 100_000,
  maxBodyBytes: 32 * 1024,
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lets the server finish writing its request log line. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * `POST /api/v1/orders` over real HTTP: the production guard, route pipe,
 * controller, adapter, ingestion service, source resolver and readiness
 * service. Only the repositories and the billing reads behind them are faked,
 * so the test proves what a request can make the acceptance repository write.
 * The app is mounted as main.ts mounts it: the API edge first, then the
 * app-wide pipe.
 */
describe('POST /api/v1/orders', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;

  const credentials = new Map(
    [
      { key: keyA, id: 'key-a', orgId: ORG_A, integrationId: SOURCE_A },
      {
        key: keyARotated,
        id: 'key-a-rotated',
        orgId: ORG_A,
        integrationId: SOURCE_A,
      },
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
  const dispatcher = {
    dispatchById: jest.fn<Promise<string>, [string]>(),
    isAlreadyDispatched: jest.fn<Promise<boolean>, [string]>(),
  };
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

  const ingestion = new StandaloneOrderIngestionService(
    acceptance as never,
    dispatcher as never,
    verifications as never,
    new StandaloneSourceResolver(integrations as never),
    new StandaloneSendReadinessService(
      entitlements as never,
      creditEligibility as never,
      {} as never,
    ),
  );
  const submitOne = jest.spyOn(ingestion, 'submitOne');

  /** Every structured line the app logged, at any level. */
  const logged: string[] = [];
  const requestLines = () =>
    logged
      .filter((line) => line.includes('"action":"order-api-request"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  /** The app as main.ts builds it, with its own throttler storage. */
  async function createApp(limits: OrderApiConfig): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // The app-wide IP throttler's module; the route skips its guard.
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 60 }] }),
      ],
      controllers: [OrderApiController],
      providers: [
        ApiOrderChannelAdapter,
        PhoneService,
        IntegrationApiKeyGuard,
        OrderApiIngressThrottleGuard,
        OrderApiThrottleGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === ORDER_API_CONFIG ? limits : undefined,
          },
        },
        { provide: IntegrationApiKeysRepository, useValue: keys },
        { provide: StandaloneOrderIngestionService, useValue: ingestion },
      ],
    }).compile();
    const created = moduleRef.createNestApplication();
    applyOrderApiEdge(created);
    // The app-wide pipe from main.ts, so the route pipe is tested behind it.
    created.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );
    await created.init();
    return created;
  }

  beforeAll(async () => {
    app = await createApp(ROOMY_LIMITS);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    logged.length = 0;
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(String(args[0]));
        });
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
    dispatcher.isAlreadyDispatched.mockResolvedValue(false);
    verifications.findByOrderId.mockResolvedValue({ id: 'verification-1' });
  });

  const untouched = () => {
    expect(acceptance.accept).not.toHaveBeenCalled();
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  };

  /** No order, event, dispatch or credit check: the command was never run. */
  const neverSubmitted = () => {
    expect(submitOne).not.toHaveBeenCalled();
    expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
    expect(entitlements.hasAvailableSlot).not.toHaveBeenCalled();
    expect(creditEligibility.resolveDenial).not.toHaveBeenCalled();
    untouched();
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
        code: 'API_VALIDATION_FAILED',
        correlationId: expect.any(String) as unknown,
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
        message: 'Order validation failed.',
        code: 'API_VALIDATION_FAILED',
        correlationId: expect.any(String) as unknown,
      });
      expect(Object.keys(response.body as object).sort()).toEqual([
        'code',
        'correlationId',
        'fieldErrors',
        'message',
      ]);
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

        expect(response.body).toEqual({
          code,
          message: expect.any(String) as unknown,
          correlationId: expect.any(String) as unknown,
        });
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

    it('answers 409 when the order already exists with different data under a new key', async () => {
      acceptance.accept.mockRejectedValue(
        new ManualOrderIdentityConflictError(),
      );
      const response = await post().send(order).expect(409);
      expect(response.body).toEqual({
        code: 'API_ORDER_EXTERNAL_ID_CONFLICT',
        message: expect.any(String) as unknown,
        correlationId: expect.any(String) as unknown,
      });
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
    });

    it('answers 202 duplicate without dispatching when the order already exists unchanged', async () => {
      acceptance.accept.mockResolvedValue({
        eventId: 'event-of-first-request',
        order: { id: 'order-1' },
        duplicate: true,
        replay: 'external_id',
      } as never);
      const response = await post().send(order).expect(202);
      expect(response.body).toMatchObject({
        orderId: 'order-1',
        status: 'accepted',
        duplicate: true,
      });
      expect(dispatcher.dispatchById).not.toHaveBeenCalled();
    });

    it('answers 202 duplicate when a retry finds its event already dispatched', async () => {
      acceptance.accept.mockResolvedValue({
        eventId: 'event-1',
        order: { id: 'order-1' },
        duplicate: true,
        replay: 'event_key',
      } as never);
      dispatcher.dispatchById.mockResolvedValue('not_claimed');
      dispatcher.isAlreadyDispatched.mockResolvedValue(true);
      const response = await post().send(order).expect(202);
      expect(response.body).toMatchObject({
        orderId: 'order-1',
        duplicate: true,
      });
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

  describe('correlation ID (US-05-04)', () => {
    it('generates one for a request that brings none and returns it on success', async () => {
      const response = await post().send(order).expect(202);

      expect(response.headers['x-correlation-id']).toMatch(UUID);
      expect(response.headers['x-request-id']).toBe(
        response.headers['x-correlation-id'],
      );
    });

    it('echoes a safe client value in the header, the error body and the log', async () => {
      const response = await post()
        .set('X-Correlation-Id', 'shop-req_2026.10.02-0001')
        .send({ ...order, currency: 'XYZ' })
        .expect(400);
      await settle();

      expect(response.headers['x-correlation-id']).toBe(
        'shop-req_2026.10.02-0001',
      );
      expect(response.body).toMatchObject({
        correlationId: 'shop-req_2026.10.02-0001',
      });
      expect(requestLines()).toEqual([
        expect.objectContaining({
          correlationId: 'shop-req_2026.10.02-0001',
          requestId: 'shop-req_2026.10.02-0001',
        }),
      ]);
    });

    it.each([
      ['markup', '<script>alert(1)</script>'],
      ['a phone number', '+201001234567'],
      ['a short value', 'abc'],
      ['a JSON fragment', '{"orgId":"x"}'],
    ])('replaces %s instead of echoing it', async (_case, supplied) => {
      const response = await request(server())
        .post('/api/v1/orders')
        .set('X-Correlation-Id', supplied)
        .send(order)
        .expect(401);
      await settle();

      const correlationId = response.headers['x-correlation-id'];
      expect(correlationId).toMatch(UUID);
      expect(response.body).toEqual({ ...UNIFORM_401, correlationId });
      expect(JSON.stringify(response.headers)).not.toContain(supplied);
      expect(logged.join('\n')).not.toContain(supplied);
    });

    it('gives the key guard the same ID to log, whatever X-Request-Id the client sent', async () => {
      const response = await request(server())
        .post('/api/v1/orders')
        .set('X-Request-Id', 'forged-request-id')
        .send(order)
        .expect(401);
      await settle();

      const correlationId = response.headers['x-correlation-id'];
      expect(response.headers['x-request-id']).toBe(correlationId);
      const guardLine = logged
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(({ action }) => action === 'integration-api-key-authenticate');
      expect(guardLine).toMatchObject({ requestId: correlationId });
      expect(logged.join('\n')).not.toContain('forged-request-id');
    });
  });

  describe('one error envelope (US-05-04)', () => {
    const ENVELOPE_KEYS = ['code', 'correlationId', 'message'];

    it.each<[string, () => request.Test, number, string]>([
      [
        'authentication',
        () => request(server()).post('/api/v1/orders').send(order),
        401,
        'API_KEY_INVALID',
      ],
      [
        'a conflict',
        () => {
          acceptance.accept.mockRejectedValue(
            new ManualOrderPayloadConflictError(),
          );
          return post().send(order);
        },
        409,
        'API_ORDER_IDEMPOTENCY_CONFLICT',
      ],
      [
        'an unready source',
        () => {
          integrations.findActiveByOrg.mockResolvedValue([]);
          return post().send(order);
        },
        409,
        'API_SOURCE_UNAVAILABLE',
      ],
      [
        'a failed acceptance',
        () => {
          acceptance.accept.mockRejectedValue(new Error('pool exhausted'));
          return post().send(order);
        },
        503,
        'API_ORDER_ACCEPTANCE_FAILED',
      ],
      [
        'an unexpected server error',
        () => {
          integrations.findActiveByOrg.mockRejectedValue(
            new TypeError('x is not a function'),
          );
          return post().send(order);
        },
        500,
        'API_INTERNAL_ERROR',
      ],
      [
        'an oversized body',
        () => post().send({ ...order, notes: 'x'.repeat(40_000) }),
        413,
        'API_PAYLOAD_TOO_LARGE',
      ],
    ])(
      'answers %s with exactly {code, message, correlationId}',
      async (_case, send, status, code) => {
        const response = await send().expect(status);

        expect(Object.keys(response.body as object).sort()).toEqual(
          ENVELOPE_KEYS,
        );
        expect(response.body).toEqual({
          code,
          message: expect.any(String) as unknown,
          correlationId: response.headers['x-correlation-id'],
        });
      },
    );

    it('adds fieldErrors to a validation failure and nothing else', async () => {
      const response = await post()
        .send({ ...order, currency: 'XYZ' })
        .expect(400);

      expect(Object.keys(response.body as object).sort()).toEqual(
        [...ENVELOPE_KEYS, 'fieldErrors'].sort(),
      );
      expect(errorOf(response).fieldErrors).toEqual({
        currency: expect.any(String) as unknown,
      });
    });
  });

  describe('body-size limit (US-05-04)', () => {
    const LIMIT = ROOMY_LIMITS.maxBodyBytes;
    const TOO_LARGE = {
      code: 'API_PAYLOAD_TOO_LARGE',
      message: 'The request body is too large.',
      correlationId: expect.any(String) as unknown,
    };
    /** A valid order padded with JSON whitespace to an exact byte size. */
    const paddedTo = (bytes: number) => {
      const text = JSON.stringify(order);
      return text + ' '.repeat(bytes - Buffer.byteLength(text));
    };
    const json = (call: request.Test) =>
      call.set('Content-Type', 'application/json');

    it('accepts a body of exactly the limit', async () => {
      await json(post()).send(paddedTo(LIMIT)).expect(202);
      expect(submitOne).toHaveBeenCalledTimes(1);
    });

    it('answers 413 API_PAYLOAD_TOO_LARGE one byte over the limit, before ingestion', async () => {
      const response = await json(post())
        .send(paddedTo(LIMIT + 1))
        .expect(413);

      expect(response.body).toEqual(TOO_LARGE);
      neverSubmitted();
    });

    it('answers 413 for a large field before validating it', async () => {
      const response = await post()
        .send({ ...order, notes: 'x'.repeat(LIMIT) })
        .expect(413);

      expect(response.body).toEqual(TOO_LARGE);
      neverSubmitted();
    });

    it('counts a chunked body that declares no length', async () => {
      const call = json(post());
      const chunk = ' '.repeat(8 * 1024);
      call.write(JSON.stringify(order));
      for (let index = 0; index < 5; index++) call.write(chunk);
      const response = await call.expect(413);

      expect(response.body).toEqual(TOO_LARGE);
      neverSubmitted();
    });

    it('applies the limit to a body that is not declared as JSON', async () => {
      const response = await post()
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`notes=${'x'.repeat(LIMIT)}`)
        .expect(413);

      expect(response.body).toEqual(TOO_LARGE);
      neverSubmitted();
    });

    it('answers 413 before authenticating, so an oversized body costs no key lookup', async () => {
      const response = await json(request(server()).post('/api/v1/orders'))
        .send(paddedTo(LIMIT + 1))
        .expect(413);

      expect(response.body).toEqual(TOO_LARGE);
      expect(keys.findByPrefixForAuthentication).not.toHaveBeenCalled();
      neverSubmitted();
    });

    it.each([
      ['malformed JSON', 'application/json', '{"externalOrderId": '],
      ['a form-encoded body', 'application/x-www-form-urlencoded', 'a=1&b=2'],
      ['plain text', 'text/plain', 'hello'],
      ['a JSON value that is not an object', 'application/json', '"10023"'],
    ])(
      'answers 400 API_VALIDATION_FAILED for %s',
      async (_case, type, text) => {
        const response = await post()
          .set('Content-Type', type)
          .send(text)
          .expect(400);

        expect(response.body).toEqual({
          code: 'API_VALIDATION_FAILED',
          message: 'The request body must be valid JSON.',
          correlationId: response.headers['x-correlation-id'],
        });
        expect(keys.findByPrefixForAuthentication).not.toHaveBeenCalled();
        neverSubmitted();
      },
    );
  });

  describe('rate limits (US-05-04)', () => {
    const LIMITS: OrderApiConfig = {
      perIntegrationPerMinute: 3,
      globalPerMinute: 5,
      preAuthPerIpPerMinute: 20,
      maxBodyBytes: 32 * 1024,
    };
    const RATE_LIMITED = {
      code: 'API_RATE_LIMITED',
      message: expect.any(String) as unknown,
      correlationId: expect.any(String) as unknown,
    };
    let limited: INestApplication;

    /** A valid, distinct order through the throttled app. */
    const submit = (key: string, reference: number) =>
      request(limited.getHttpServer() as Server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${key}`)
        .set('Idempotency-Key', `api-order-${reference}`)
        .send({ ...order, externalOrderId: String(reference) });

    const submitTimes = async (key: string, count: number, from = 1) => {
      for (let index = 0; index < count; index++)
        await submit(key, from + index).expect(202);
    };

    // Each test gets its own app, and with it empty throttler buckets.
    beforeEach(async () => {
      limited = await createApp(LIMITS);
    });

    afterEach(async () => {
      await limited.close();
    });

    it('answers 429 API_RATE_LIMITED with Retry-After after a burst, before the adapter runs', async () => {
      await submitTimes(keyA.plaintext, LIMITS.perIntegrationPerMinute);
      jest.clearAllMocks();

      const response = await submit(keyA.plaintext, 99).expect(429);

      expect(response.body).toEqual(RATE_LIMITED);
      const retryAfter = Number(response.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      neverSubmitted();
    });

    it('throttles before validation: a throttled request is not even read', async () => {
      await submitTimes(keyA.plaintext, LIMITS.perIntegrationPerMinute);
      jest.clearAllMocks();

      const response = await request(limited.getHttpServer() as Server)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${keyA.plaintext}`)
        .send({ nonsense: true })
        .expect(429);

      expect(response.body).toEqual(RATE_LIMITED);
      neverSubmitted();
    });

    it('lets exactly the limit through under concurrent load', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          submit(keyA.plaintext, 100 + index),
        ),
      );

      const statuses = responses.map(({ status }) => status);
      expect(statuses.filter((status) => status === 202)).toHaveLength(
        LIMITS.perIntegrationPerMinute,
      );
      expect(statuses.filter((status) => status === 429)).toHaveLength(
        10 - LIMITS.perIntegrationPerMinute,
      );
      expect(submitOne).toHaveBeenCalledTimes(LIMITS.perIntegrationPerMinute);
      expect(acceptance.accept).toHaveBeenCalledTimes(
        LIMITS.perIntegrationPerMinute,
      );
      expect(dispatcher.dispatchById).toHaveBeenCalledTimes(
        LIMITS.perIntegrationPerMinute,
      );
    });

    it('refuses a rotated key of a throttled integration', async () => {
      await submitTimes(keyA.plaintext, LIMITS.perIntegrationPerMinute);
      jest.clearAllMocks();

      const response = await submit(keyARotated.plaintext, 99).expect(429);

      expect(response.body).toEqual(RATE_LIMITED);
      neverSubmitted();
    });

    it('keeps serving another integration while one is throttled', async () => {
      await submitTimes(keyA.plaintext, LIMITS.perIntegrationPerMinute);
      await submit(keyA.plaintext, 99).expect(429);

      await submit(keyB.plaintext, 1).expect(202);
    });

    it('applies the global limit across integrations', async () => {
      await submitTimes(keyA.plaintext, 3);
      await submitTimes(keyB.plaintext, 2);
      jest.clearAllMocks();

      // Integration B has used 2 of its own 3; the global 5 are spent.
      const response = await submit(keyB.plaintext, 99).expect(429);

      expect(response.body).toEqual(RATE_LIMITED);
      expect(response.headers['retry-after']).toBeDefined();
      neverSubmitted();
    });

    it('bounds requests without a valid key before they reach the key lookup', async () => {
      const bad = () =>
        request(limited.getHttpServer() as Server)
          .post('/api/v1/orders')
          .set('Authorization', `Bearer ${unknownKey.plaintext}`)
          .send(order);
      for (let index = 0; index < LIMITS.preAuthPerIpPerMinute; index++)
        await bad().expect(401);
      expect(keys.findByPrefixForAuthentication).toHaveBeenCalledTimes(
        LIMITS.preAuthPerIpPerMinute,
      );
      jest.clearAllMocks();

      const response = await bad().expect(429);

      expect(response.body).toEqual(RATE_LIMITED);
      expect(response.headers['retry-after']).toBeDefined();
      expect(keys.findByPrefixForAuthentication).not.toHaveBeenCalled();
      neverSubmitted();
    });

    it('logs a throttled request with its integration and the outcome code', async () => {
      await submitTimes(keyA.plaintext, LIMITS.perIntegrationPerMinute);
      logged.length = 0;

      const response = await submit(keyA.plaintext, 99).expect(429);
      await settle();

      expect(requestLines()).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          httpStatus: 429,
          resultCode: 'API_RATE_LIMITED',
          integrationId: SOURCE_A,
          keyPrefix: keyA.prefix,
          correlationId: response.headers['x-correlation-id'],
        }),
      ]);
    });
  });

  describe('request log (US-05-04)', () => {
    /** Things no log line or error body may ever contain. */
    const SECRETS = [
      keyA.plaintext,
      keyA.plaintext.slice(keyA.prefix.length + 1),
      keyA.keyHash,
      unknownKey.plaintext,
      unknownKey.plaintext.slice(unknownKey.prefix.length + 1),
      '+201001234567',
      '201001234567',
      'Mona Ali',
      '12 Nile St',
      'Call before delivery',
    ];
    const pii = {
      ...order,
      address: '12 Nile St',
      notes: 'Call before delivery',
    };

    const expectClean = (response: request.Response) => {
      const lines = logged.join('\n');
      const sent = JSON.stringify(response.body);
      for (const secret of SECRETS) {
        expect(lines).not.toContain(secret);
        expect(sent).not.toContain(secret);
      }
    };

    it('writes one line for an accepted order: integration, key prefix, correlation ID, outcome, duration and order', async () => {
      const response = await post().send(pii).expect(202);
      await settle();

      const lines = requestLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        app: 'backend',
        module: 'OrderApi',
        action: 'order-api-request',
        outcome: 'success',
        httpStatus: 202,
        resultCode: 'accepted',
        orgId: ORG_A,
        integrationId: SOURCE_A,
        keyId: 'key-a',
        keyPrefix: keyA.prefix,
        orderId: 'order-1',
        correlationId: response.headers['x-correlation-id'],
        requestId: response.headers['x-correlation-id'],
      });
      expect(typeof lines[0].durationMs).toBe('number');
      expect(Object.keys(lines[0]).sort()).toEqual(
        [
          'action',
          'app',
          'correlationId',
          'durationMs',
          'env',
          'httpStatus',
          'integrationId',
          'keyId',
          'keyPrefix',
          'module',
          'orderId',
          'orgId',
          'outcome',
          'requestId',
          'resultCode',
        ].sort(),
      );
      expectClean(response);
    });

    it('marks a replay as duplicate', async () => {
      acceptance.accept.mockResolvedValue({
        eventId: 'event-1',
        order: { id: 'order-1' },
        duplicate: true,
      });
      await post().send(order).expect(202);
      await settle();

      expect(requestLines()).toEqual([
        expect.objectContaining({
          resultCode: 'duplicate',
          orderId: 'order-1',
        }),
      ]);
    });

    it('redacts the authentication failure path', async () => {
      const response = await request(server())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${unknownKey.plaintext}`)
        .set('Idempotency-Key', 'order-10023')
        .send(pii)
        .expect(401);
      await settle();

      const lines = requestLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        outcome: 'failure',
        httpStatus: 401,
        resultCode: 'API_KEY_INVALID',
        correlationId: response.headers['x-correlation-id'],
      });
      // Nobody authenticated, so the line names no tenant.
      for (const field of ['orgId', 'integrationId', 'keyId', 'keyPrefix'])
        expect(lines[0]).not.toHaveProperty(field);
      expectClean(response);
    });

    it('redacts a key sent in the query string', async () => {
      const response = await request(server())
        .post(`/api/v1/orders?api_key=${keyA.plaintext}`)
        .set('Authorization', `Bearer ${keyA.plaintext}`)
        .send(pii)
        .expect(401);
      await settle();

      expect(requestLines()).toHaveLength(1);
      expectClean(response);
    });

    it('redacts the validation failure path', async () => {
      const response = await post()
        .send({ ...pii, currency: 'XYZ', discountCode: 'Mona Ali' })
        .expect(400);
      await settle();

      const lines = requestLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        outcome: 'failure',
        httpStatus: 400,
        resultCode: 'API_VALIDATION_FAILED',
        integrationId: SOURCE_A,
        keyPrefix: keyA.prefix,
      });
      expect(lines[0]).not.toHaveProperty('orderId');
      expectClean(response);
    });

    it.each([
      [
        'a key replayed with different data',
        new ManualOrderPayloadConflictError(),
        'API_ORDER_IDEMPOTENCY_CONFLICT',
      ],
      [
        'an existing order with different data',
        new ManualOrderIdentityConflictError(),
        'API_ORDER_EXTERNAL_ID_CONFLICT',
      ],
    ])('redacts the conflict path: %s', async (_case, conflict, code) => {
      acceptance.accept.mockRejectedValue(conflict);
      const response = await post().send(pii).expect(409);
      await settle();

      const lines = requestLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        outcome: 'failure',
        httpStatus: 409,
        resultCode: code,
        integrationId: SOURCE_A,
      });
      expectClean(response);
    });

    it('redacts the database error path and never shows another tenant', async () => {
      const databaseError = Object.assign(
        new Error(
          `select "id" from "integrations" where "org_id" = '${ORG_B}' -- customer +201001234567 Mona Ali`,
        ),
        {
          code: '57P01',
          query: `select * from integrations /* ${SOURCE_B} */`,
        },
      );
      integrations.findActiveByOrg.mockRejectedValue(databaseError);

      const response = await post().send(pii).expect(500);
      await settle();

      expect(response.body).toEqual({
        code: 'API_INTERNAL_ERROR',
        message: expect.any(String) as unknown,
        correlationId: response.headers['x-correlation-id'],
      });
      const lines = requestLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        outcome: 'failure',
        httpStatus: 500,
        resultCode: 'API_INTERNAL_ERROR',
        errorCode: '57P01',
        orgId: ORG_A,
        integrationId: SOURCE_A,
      });
      const everything = `${logged.join('\n')}\n${JSON.stringify(response.body)}`;
      for (const leak of [ORG_B, SOURCE_B, 'select', 'integrations', 'org_id'])
        expect(everything).not.toContain(leak);
      expectClean(response);
      untouched();
    });

    it('keeps the cause of a failed acceptance out of the response and the request line', async () => {
      acceptance.accept.mockRejectedValue(
        new Error(`insert into "orders" failed for ${ORG_B} +201001234567`),
      );
      const response = await post().send(pii).expect(503);
      await settle();

      expect(response.body).toEqual({
        code: 'API_ORDER_ACCEPTANCE_FAILED',
        message: expect.any(String) as unknown,
        correlationId: response.headers['x-correlation-id'],
      });
      const lines = requestLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        httpStatus: 503,
        resultCode: 'API_ORDER_ACCEPTANCE_FAILED',
      });
      const line = JSON.stringify(lines[0]);
      for (const leak of [ORG_B, 'insert into', '+201001234567'])
        expect(line).not.toContain(leak);
    });

    it('writes one line for an oversized body, with no tenant and no content', async () => {
      const response = await post()
        .send({ ...pii, notes: 'Mona Ali '.repeat(8_000) })
        .expect(413);
      await settle();

      const lines = requestLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        outcome: 'failure',
        httpStatus: 413,
        resultCode: 'API_PAYLOAD_TOO_LARGE',
        correlationId: response.headers['x-correlation-id'],
      });
      expect(lines[0]).not.toHaveProperty('integrationId');
      expectClean(response);
    });
  });
});
