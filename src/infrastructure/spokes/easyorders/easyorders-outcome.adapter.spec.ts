import type { ConfigService } from '@nestjs/config';
import type { EasyOrdersConnectionsRepository } from '../../database/repositories/easyorders-connections.repository';
import type {
  CommerceOutcomeAction,
  CommerceOutcomeAdapterRequest,
} from '../../../shared/commerce/commerce-outcome';
import { COMMERCE_OUTCOME_ACTIONS } from '../../../shared/commerce/commerce-outcome';
import { EASYORDERS_CONFIG } from '../../../shared/config/easyorders.config';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import {
  EASYORDERS_INACTIVE_STORE_MESSAGE,
  EasyOrdersApiClient,
  type EasyOrdersHttp,
} from './easyorders-api.client';
import { EasyOrdersOutcomeAdapter } from './easyorders-outcome.adapter';
import {
  EASYORDERS_REQUESTS_PER_MINUTE,
  EasyOrdersRateLimiter,
} from './easyorders-rate-limiter';

const ENCRYPTION_KEY = 'k'.repeat(32);
const API_KEY = 'eo_unit_test_key';
const STORE_ID = 'store-1';
const ORDER_ID = 'order-1';

type Step = () => Response | Promise<Response>;

const order = (status: unknown, storeId: unknown = STORE_ID) =>
  Response.json({ id: ORDER_ID, store_id: storeId, status });
const timeout = (): Promise<Response> =>
  Promise.reject(new DOMException('timed out', 'TimeoutError'));

function setup(
  options: {
    enabled?: boolean;
    connection?: Record<string, unknown> | null;
    steps?: Step[];
  } = {},
) {
  const steps = [...(options.steps ?? [])];
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const http: EasyOrdersHttp = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: typeof input === 'string' ? input : '',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    expect(new Headers(init?.headers).get('Api-Key')).toBe(API_KEY);
    const step = steps.shift();
    if (!step) throw new Error('unexpected EasyOrders request');
    return Promise.resolve(step());
  };
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(
      options.connection === null
        ? undefined
        : {
            integrationId: 'integration-1',
            orgId: 'org-1',
            storeId: STORE_ID,
            apiKeyEncrypted: encryptToken(API_KEY, ENCRYPTION_KEY),
            health: 'ok',
            ...options.connection,
          },
    ),
    setHealth: jest.fn().mockResolvedValue(undefined),
  };
  const limiter = new EasyOrdersRateLimiter();
  const config = {
    get: (key: string) =>
      key === EASYORDERS_CONFIG
        ? { outcomeSyncEnabled: options.enabled ?? true }
        : undefined,
    getOrThrow: () => ENCRYPTION_KEY,
  } as unknown as ConfigService;
  const adapter = new EasyOrdersOutcomeAdapter(
    connections as unknown as EasyOrdersConnectionsRepository,
    new EasyOrdersApiClient(http),
    limiter,
    config,
  );
  const execute = (action: CommerceOutcomeAction = 'customer_confirmation') =>
    adapter.execute({
      orgId: 'org-1',
      integrationId: 'integration-1',
      externalOrderId: ORDER_ID,
      action,
      correlationId: 'verification-1',
      connection: {} as CommerceOutcomeAdapterRequest['connection'],
    });
  return { adapter, execute, requests, connections, limiter };
}

describe('EasyOrdersOutcomeAdapter', () => {
  describe('capabilities', () => {
    it('offers only the three approved actions, and tracks synchronization', () => {
      const { adapter } = setup();

      expect([...adapter.capabilities].sort()).toEqual([
        'customer_cancellation',
        'customer_confirmation',
        'merchant_no_reply_cancellation',
      ]);
      expect(adapter.platformType).toBe('easyorders');
      expect(adapter.tracksSynchronization).toBe(true);
      expect(adapter.requiresActiveConnection).toBe(true);
    });

    it('offers nothing while remote writes are switched off', async () => {
      const { adapter, execute, requests, connections } = setup({
        enabled: false,
      });

      expect(adapter.capabilities.size).toBe(0);
      await expect(execute()).resolves.toEqual({
        status: 'unsupported',
        reason: 'capability_not_supported',
      });
      expect(connections.findByIntegration).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    });

    it('is off when the configuration was never validated', () => {
      const adapter = new EasyOrdersOutcomeAdapter(
        {} as never,
        {} as never,
        new EasyOrdersRateLimiter(),
        { get: () => undefined } as unknown as ConfigService,
      );

      expect(adapter.capabilities.size).toBe(0);
    });

    it.each(
      COMMERCE_OUTCOME_ACTIONS.filter((action) => action.endsWith('_tagging')),
    )('never sends a request for %s', async (action) => {
      const { execute, requests } = setup();

      await expect(execute(action)).resolves.toEqual({
        status: 'unsupported',
        reason: 'capability_not_supported',
      });
      expect(requests).toHaveLength(0);
    });
  });

  describe('approved mapping', () => {
    it.each<[CommerceOutcomeAction, string]>([
      ['customer_confirmation', 'confirmed'],
      ['customer_cancellation', 'canceled'],
      ['merchant_no_reply_cancellation', 'canceled'],
    ])('%s writes %s from pending', async (action, status) => {
      const { execute, requests, connections } = setup({
        steps: [() => order('pending'), () => Response.json({})],
      });

      await expect(execute(action)).resolves.toEqual({
        status: 'applied',
        providerStatus: status,
      });

      expect(connections.findByIntegration).toHaveBeenCalledWith(
        'integration-1',
        'org-1',
      );
      expect(requests).toEqual([
        {
          method: 'GET',
          url: `https://api.easy-orders.net/api/v1/external-apps/orders/${ORDER_ID}`,
        },
        {
          method: 'PATCH',
          url: `https://api.easy-orders.net/api/v1/external-apps/orders/${ORDER_ID}/status`,
          body: JSON.stringify({ status }),
        },
      ]);
    });
  });

  describe('current remote state', () => {
    it('reports an order already at the target without writing again', async () => {
      const { execute, requests } = setup({
        steps: [() => order('confirmed')],
      });

      await expect(execute()).resolves.toEqual({
        status: 'applied',
        providerStatus: 'confirmed',
      });
      expect(requests).toHaveLength(1);
    });

    it.each(['delivered', 'canceled', 'refunded', 'in_delivery', 'paid'])(
      'never overwrites %s',
      async (current) => {
        const { execute, requests } = setup({ steps: [() => order(current)] });

        await expect(execute('customer_confirmation')).resolves.toEqual({
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
          providerStatus: current,
        });
        expect(requests.map((request) => request.method)).toEqual(['GET']);
      },
    );

    it.each([
      ['no status', () => order(undefined), 'remote_state_unreadable'],
      [
        'free text as a status',
        () => order('on its way'),
        'remote_state_unreadable',
      ],
      ['no store id', () => order('pending', null), 'store_unverified'],
      ['another store', () => order('pending', 'store-2'), 'store_mismatch'],
    ])('fails closed on %s', async (_name, answer, errorCode) => {
      const { execute, requests } = setup({ steps: [answer] });

      await expect(execute()).resolves.toEqual({
        status: 'permanent_failure',
        errorCode,
      });
      expect(requests).toHaveLength(1);
    });

    it('reports an order the key cannot see', async () => {
      const { execute } = setup({
        steps: [() => new Response(null, { status: 404 })],
      });

      await expect(execute()).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'order_not_found',
      });
    });
  });

  describe('a write whose answer was lost', () => {
    it('reads the order back and reports success when it was taken', async () => {
      const { execute, requests } = setup({
        steps: [() => order('pending'), timeout, () => order('confirmed')],
      });

      await expect(execute()).resolves.toEqual({
        status: 'applied',
        providerStatus: 'confirmed',
      });
      expect(requests.map((request) => request.method)).toEqual([
        'GET',
        'PATCH',
        'GET',
      ]);
    });

    it('asks for a retry, not a blind rewrite, when it was not taken', async () => {
      const { execute, requests } = setup({
        steps: [() => order('pending'), timeout, () => order('pending')],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'write_unconfirmed',
      });
      expect(
        requests.filter((request) => request.method === 'PATCH'),
      ).toHaveLength(1);
    });

    it('treats a 5xx as ambiguous too', async () => {
      const { execute } = setup({
        steps: [
          () => order('pending'),
          () => new Response(null, { status: 502 }),
          () => order('confirmed'),
        ],
      });

      await expect(execute()).resolves.toMatchObject({ status: 'applied' });
    });

    it('never claims success when the read-back fails as well', async () => {
      const { execute } = setup({
        steps: [() => order('pending'), timeout, timeout],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'write_unconfirmed',
      });
    });

    it('stops when the order moved to another state meanwhile', async () => {
      const { execute } = setup({
        steps: [() => order('pending'), timeout, () => order('canceled')],
      });

      await expect(execute('customer_confirmation')).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: 'canceled',
      });
    });
  });

  describe('throttling', () => {
    it('honors Retry-After on a 429 and pauses the integration', async () => {
      const { execute, limiter } = setup({
        steps: [
          () =>
            new Response(null, {
              status: 429,
              headers: { 'retry-after': '17' },
            }),
        ],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'source_rate_limited',
        retryAfterMs: 17_000,
      });
      expect(limiter.acquire('integration-1', 'lookup')).toMatchObject({
        allowed: false,
      });
      expect(limiter.acquire('integration-2', 'lookup')).toEqual({
        allowed: true,
      });
    });

    it('waits for the next minute when a 429 on the write names no delay', async () => {
      const { execute } = setup({
        steps: [
          () => order('pending'),
          () => new Response(null, { status: 429 }),
        ],
      });

      const result = await execute();

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'source_rate_limited',
      });
      const waitMs = (result as { retryAfterMs: number }).retryAfterMs;
      expect(waitMs).toBeGreaterThan(0);
      expect(waitMs).toBeLessThanOrEqual(70_000);
    });

    it('sends nothing once the integration’s budget is spent', async () => {
      const { execute, requests, limiter } = setup();
      for (let used = 0; used < EASYORDERS_REQUESTS_PER_MINUTE; used += 1)
        limiter.acquire('integration-1', 'outcome');

      const result = await execute();

      expect(result).toMatchObject({
        status: 'retryable_failure',
        errorCode: 'source_rate_budget_exhausted',
      });
      expect((result as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(
        0,
      );
      expect(requests).toHaveLength(0);
    });
  });

  describe('credentials and store health', () => {
    it.each([401, 403])(
      'stops on a %i, flags assisted action and records the health',
      async (status) => {
        const { execute, connections, requests } = setup({
          steps: [() => new Response(null, { status })],
        });

        await expect(execute()).resolves.toEqual({
          status: 'permanent_failure',
          errorCode: 'source_credentials_rejected',
          requiresAssistance: true,
        });
        expect(connections.setHealth).toHaveBeenCalledWith(
          'integration-1',
          'org-1',
          'credentials_rejected',
        );
        expect(requests).toHaveLength(1);
      },
    );

    it('stops on a key revoked between the read and the write', async () => {
      const { execute } = setup({
        steps: [
          () => order('pending'),
          () => new Response(null, { status: 401 }),
        ],
      });

      await expect(execute()).resolves.toMatchObject({
        status: 'permanent_failure',
        errorCode: 'source_credentials_rejected',
        requiresAssistance: true,
      });
    });

    it('retries an inactive store slowly, as a health state', async () => {
      const { execute, connections } = setup({
        steps: [
          () =>
            Response.json(
              { message: EASYORDERS_INACTIVE_STORE_MESSAGE },
              { status: 400 },
            ),
        ],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'source_store_inactive',
        retryAfterMs: 300_000,
      });
      expect(connections.setHealth).toHaveBeenCalledWith(
        'integration-1',
        'org-1',
        'store_inactive',
      );
    });

    it('clears a stale health state once the key works again', async () => {
      const { execute, connections } = setup({
        connection: { health: 'store_inactive' },
        steps: [() => order('confirmed')],
      });

      await execute();

      expect(connections.setHealth).toHaveBeenCalledWith(
        'integration-1',
        'org-1',
        'ok',
      );
    });

    it('reports a transition EasyOrders refuses as permanent', async () => {
      const { execute } = setup({
        steps: [
          () => order('pending'),
          () => Response.json({ message: 'nope' }, { status: 422 }),
        ],
      });

      await expect(execute()).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'remote_rejected',
      });
    });

    it('retries when EasyOrders cannot be reached for the read', async () => {
      const { execute } = setup({ steps: [timeout] });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'source_unavailable',
      });
    });
  });

  describe('connection', () => {
    it('fails without a request when the integration has no connection', async () => {
      const { execute, requests } = setup({ connection: null });

      await expect(execute()).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'connection_missing',
      });
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['is not an envelope', 'v1:not-a-real-envelope'],
      ['was sealed with another key', encryptToken(API_KEY, 'x'.repeat(32))],
    ])(
      'flags assisted action when the stored key %s',
      async (_name, stored) => {
        const { execute, requests } = setup({
          connection: { apiKeyEncrypted: stored },
        });

        await expect(execute()).resolves.toEqual({
          status: 'permanent_failure',
          errorCode: 'credentials_unreadable',
          requiresAssistance: true,
        });
        expect(requests).toHaveLength(0);
      },
    );
  });
});
