import type { ConfigService } from '@nestjs/config';
import type { WooCommerceConnectionsRepository } from '../../database/repositories/woocommerce-connections.repository';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAction,
  type CommerceOutcomeAdapterRequest,
} from '../../../shared/commerce/commerce-outcome';
import { WOOCOMMERCE_CONFIG } from '../../../shared/config/woocommerce.config';
import {
  RestrictedHttpError,
  type RestrictedHttpRequest,
  type RestrictedHttpResponse,
} from '../../../shared/http/restricted-http';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import { WooCommerceApiClient } from './woocommerce-api.client';
import { WooCommerceOutcomeAdapter } from './woocommerce-outcome.adapter';
import { WOOCOMMERCE_CONFIRMATION_NOTE } from './woocommerce-outcome.mapping';

const ENCRYPTION_KEY = 'k'.repeat(32);
const CONSUMER_KEY = 'ck_unit_test_key';
const CONSUMER_SECRET = 'cs_unit_test_secret';
const BASIC = `Basic ${Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64')}`;
const STORE = 'https://shop.example.com';
const ORDER_ID = '1001';
const ORDER_URL = `${STORE}/wp-json/wc/v3/orders/${ORDER_ID}`;
const CORRELATION_ID = 'verification-1';
const markerOf = (action: CommerceOutcomeAction) =>
  `${action}:${CORRELATION_ID}`;

type Step = () => RestrictedHttpResponse | Promise<RestrictedHttpResponse>;

const answer = (
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): RestrictedHttpResponse => ({
  status,
  headers,
  body: Buffer.from(JSON.stringify(body)),
});

/** The store's order, with the markers it carries. */
const order = (status: unknown, markers: string[] = [], href = ORDER_URL) =>
  answer(200, {
    id: 1001,
    status,
    meta_data: markers.map((value, index) => ({
      id: index + 1,
      key: 'akeed_outcome',
      value,
    })),
    _links: { self: [{ href }] },
  });
const lost = (code: 'timeout' | 'network' = 'timeout'): Step => {
  return () =>
    Promise.reject(new RestrictedHttpError(code, 'shop.example.com'));
};
const noteCreated: Step = () => answer(201, { id: 281 });

function setup(
  options: {
    enabled?: boolean;
    connection?: Record<string, unknown> | null;
    steps?: Step[];
  } = {},
) {
  const steps = [...(options.steps ?? [])];
  const requests: RestrictedHttpRequest[] = [];
  const api = new WooCommerceApiClient((request) => {
    requests.push(request);
    expect(request.authorization).toBe(BASIC);
    const step = steps.shift();
    if (!step) throw new Error('unexpected WooCommerce request');
    return Promise.resolve(step());
  });
  const connections = {
    findByIntegration: jest.fn().mockResolvedValue(
      options.connection === null
        ? undefined
        : {
            integrationId: 'integration-1',
            orgId: 'org-1',
            storeUrl: STORE,
            consumerKeyEncrypted: encryptToken(CONSUMER_KEY, ENCRYPTION_KEY),
            consumerSecretEncrypted: encryptToken(
              CONSUMER_SECRET,
              ENCRYPTION_KEY,
            ),
            health: 'ok',
            ...options.connection,
          },
    ),
    setHealth: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: (key: string) =>
      key === WOOCOMMERCE_CONFIG
        ? { outcomeSyncEnabled: options.enabled ?? true }
        : undefined,
    getOrThrow: () => ENCRYPTION_KEY,
  } as unknown as ConfigService;
  const adapter = new WooCommerceOutcomeAdapter(
    connections as unknown as WooCommerceConnectionsRepository,
    api,
    config,
  );
  const execute = (action: CommerceOutcomeAction = 'customer_confirmation') =>
    adapter.execute({
      orgId: 'org-1',
      integrationId: 'integration-1',
      externalOrderId: ORDER_ID,
      action,
      correlationId: CORRELATION_ID,
      connection: {} as CommerceOutcomeAdapterRequest['connection'],
    });
  const sent = () =>
    requests.map((request) => ({
      method: request.method,
      url: request.url,
      ...(request.body ? { body: JSON.parse(request.body) as unknown } : {}),
    }));
  const methods = () => requests.map((request) => request.method);
  return { adapter, execute, requests, sent, methods, connections };
}

describe('WooCommerceOutcomeAdapter', () => {
  describe('capabilities', () => {
    it('offers only the three approved actions, and tracks synchronization', () => {
      const { adapter } = setup();

      expect([...adapter.capabilities].sort()).toEqual([
        'customer_cancellation',
        'customer_confirmation',
        'merchant_no_reply_cancellation',
      ]);
      expect(adapter.platformType).toBe('woocommerce');
      expect(adapter.tracksSynchronization).toBe(true);
      expect(adapter.requiresActiveConnection).toBe(true);
    });

    it('offers nothing while remote writes are switched off', async () => {
      const { adapter, execute, requests, connections } = setup({
        enabled: false,
      });

      expect(adapter.capabilities.size).toBe(0);
      for (const action of COMMERCE_OUTCOME_ACTIONS)
        await expect(execute(action)).resolves.toEqual({
          status: 'unsupported',
          reason: 'capability_not_supported',
        });
      expect(connections.findByIntegration).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    });

    it('is off when the configuration was never validated', () => {
      const adapter = new WooCommerceOutcomeAdapter(
        {} as never,
        {} as never,
        { get: () => undefined } as unknown as ConfigService,
      );

      expect(adapter.capabilities.size).toBe(0);
    });

    it.each(['automatic_no_reply_tagging', 'merchant_cancellation_tagging'])(
      'never sends a request for %s',
      async (action) => {
        const { execute, requests, connections } = setup();

        await expect(execute(action as CommerceOutcomeAction)).resolves.toEqual(
          { status: 'unsupported', reason: 'capability_not_supported' },
        );
        expect(connections.findByIntegration).not.toHaveBeenCalled();
        expect(requests).toHaveLength(0);
      },
    );
  });

  describe('approved mapping', () => {
    it.each(['processing', 'on-hold'])(
      'a confirmation writes the marker and one note from %s, and no status',
      async (current) => {
        const marker = markerOf('customer_confirmation');
        const { execute, sent, connections } = setup({
          steps: [
            () => order(current),
            () => order(current, [marker]),
            noteCreated,
          ],
        });

        await expect(execute('customer_confirmation')).resolves.toEqual({
          status: 'applied',
          providerStatus: current,
        });

        expect(connections.findByIntegration).toHaveBeenCalledWith(
          'integration-1',
          'org-1',
        );
        expect(sent()).toEqual([
          { method: 'GET', url: ORDER_URL },
          {
            method: 'PUT',
            url: ORDER_URL,
            body: { meta_data: [{ key: 'akeed_outcome', value: marker }] },
          },
          {
            method: 'POST',
            url: `${ORDER_URL}/notes`,
            body: { note: WOOCOMMERCE_CONFIRMATION_NOTE, customer_note: false },
          },
        ]);
      },
    );

    it.each<[CommerceOutcomeAction, string]>([
      ['customer_cancellation', 'processing'],
      ['customer_cancellation', 'on-hold'],
      ['merchant_no_reply_cancellation', 'processing'],
      ['merchant_no_reply_cancellation', 'on-hold'],
    ])(
      '%s writes cancelled and the marker in one update from %s, and no note',
      async (action, current) => {
        const marker = markerOf(action);
        const { execute, sent } = setup({
          steps: [() => order(current), () => order('cancelled', [marker])],
        });

        await expect(execute(action)).resolves.toEqual({
          status: 'applied',
          providerStatus: 'cancelled',
        });

        expect(sent()).toEqual([
          { method: 'GET', url: ORDER_URL },
          {
            method: 'PUT',
            url: ORDER_URL,
            body: {
              status: 'cancelled',
              meta_data: [{ key: 'akeed_outcome', value: marker }],
            },
          },
        ]);
      },
    );

    it('never sends processing, completed or a paid flag', async () => {
      for (const action of [
        'customer_confirmation',
        'customer_cancellation',
        'merchant_no_reply_cancellation',
      ] as const) {
        const marker = markerOf(action);
        const { execute, requests } = setup({
          steps: [
            () => order('processing'),
            () =>
              order(
                action === 'customer_confirmation' ? 'processing' : 'cancelled',
                [marker],
              ),
            noteCreated,
          ],
        });

        await execute(action);

        for (const request of requests)
          expect(request.body ?? '').not.toMatch(
            /set_paid|"processing"|"completed"|"refunded"|_method/,
          );
      }
    });
  });

  describe('current remote state', () => {
    it('reports a confirmation already marked without writing or adding a note', async () => {
      const { execute, methods } = setup({
        steps: [() => order('processing', [markerOf('customer_confirmation')])],
      });

      await expect(execute('customer_confirmation')).resolves.toEqual({
        status: 'applied',
        providerStatus: 'processing',
      });
      expect(methods()).toEqual(['GET']);
    });

    it('still reports a marked confirmation as done once the merchant has moved the order on', async () => {
      const { execute, methods } = setup({
        steps: [() => order('completed', [markerOf('customer_confirmation')])],
      });

      await expect(execute('customer_confirmation')).resolves.toEqual({
        status: 'applied',
        providerStatus: 'completed',
      });
      expect(methods()).toEqual(['GET']);
    });

    it('matches the marker among several akeed_outcome entries', async () => {
      const { execute, methods } = setup({
        steps: [
          () =>
            order('processing', [
              'customer_confirmation:another-verification',
              markerOf('customer_confirmation'),
            ]),
        ],
      });

      await expect(execute('customer_confirmation')).resolves.toMatchObject({
        status: 'applied',
      });
      expect(methods()).toEqual(['GET']);
    });

    it('writes a confirmation when only another outcome’s marker is there', async () => {
      const { execute, methods } = setup({
        steps: [
          () =>
            order('processing', ['customer_confirmation:another-verification']),
          () =>
            order('processing', [
              'customer_confirmation:another-verification',
              markerOf('customer_confirmation'),
            ]),
          noteCreated,
        ],
      });

      await expect(execute('customer_confirmation')).resolves.toMatchObject({
        status: 'applied',
      });
      expect(methods()).toEqual(['GET', 'PUT', 'POST']);
    });

    it.each<[CommerceOutcomeAction, string[]]>([
      ['customer_cancellation', [markerOf('customer_cancellation')]],
      // Cancelled by the merchant, or by an earlier write of another outcome.
      ['customer_cancellation', []],
      ['merchant_no_reply_cancellation', []],
    ])(
      'reports %s on an order already cancelled without writing',
      async (action, markers) => {
        const { execute, methods } = setup({
          steps: [() => order('cancelled', markers)],
        });

        await expect(execute(action)).resolves.toEqual({
          status: 'applied',
          providerStatus: 'cancelled',
        });
        expect(methods()).toEqual(['GET']);
      },
    );

    it.each([
      'pending',
      'completed',
      'cancelled',
      'refunded',
      'failed',
      'trash',
      'checkout-draft',
      'wc-custom-status',
    ])('never overwrites %s with a confirmation', async (current) => {
      const { execute, methods } = setup({ steps: [() => order(current)] });

      await expect(execute('customer_confirmation')).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: current,
      });
      expect(methods()).toEqual(['GET']);
    });

    it.each([
      'pending',
      'completed',
      'refunded',
      'failed',
      'trash',
      'wc-custom-status',
    ])('never overwrites %s with a cancellation', async (current) => {
      const { execute, methods } = setup({ steps: [() => order(current)] });

      await expect(execute('merchant_no_reply_cancellation')).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: current,
      });
      expect(methods()).toEqual(['GET']);
    });

    it('does not cancel a second time an order the merchant reopened after the cancellation', async () => {
      const { execute, methods } = setup({
        steps: [() => order('processing', [markerOf('customer_cancellation')])],
      });

      await expect(execute('customer_cancellation')).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: 'processing',
      });
      expect(methods()).toEqual(['GET']);
    });

    it.each([
      ['no status', undefined],
      ['free text as a status', 'on its way'],
      ['a status longer than 64 characters', 'x'.repeat(65)],
    ])(
      'treats %s as a conflict and names no status',
      async (_label, status) => {
        const { execute, methods } = setup({ steps: [() => order(status)] });

        const result = await execute('customer_cancellation');

        expect(result).toEqual({
          status: 'permanent_failure',
          errorCode: 'remote_state_conflict',
        });
        expect(methods()).toEqual(['GET']);
      },
    );

    it.each([
      [
        'another store',
        () =>
          order(
            'processing',
            [],
            'https://other.example.com/wp-json/wc/v3/orders/1001',
          ),
      ],
      [
        'another order',
        () => order('processing', [], `${STORE}/wp-json/wc/v3/orders/1002`),
      ],
      ['no order at all', () => answer(200, { ok: true })],
    ])('fails closed when the answer is %s', async (_label, step: Step) => {
      const { execute, methods } = setup({ steps: [step] });

      await expect(execute()).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'store_unverified',
      });
      expect(methods()).toEqual(['GET']);
    });

    it('reports an order the store does not have', async () => {
      const { execute } = setup({ steps: [() => answer(404)] });

      await expect(execute()).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'order_not_found',
      });
    });
  });

  describe('a write whose answer was lost', () => {
    it.each(['timeout', 'network'] as const)(
      'reads the order back after a %s and reports success when it was taken',
      async (code) => {
        const marker = markerOf('customer_cancellation');
        const { execute, methods } = setup({
          steps: [
            () => order('processing'),
            lost(code),
            () => order('cancelled', [marker]),
          ],
        });

        await expect(execute('customer_cancellation')).resolves.toEqual({
          status: 'applied',
          providerStatus: 'cancelled',
        });
        expect(methods()).toEqual(['GET', 'PUT', 'GET']);
      },
    );

    it('adds the note once the read-back shows the confirmation was taken', async () => {
      const marker = markerOf('customer_confirmation');
      const { execute, methods } = setup({
        steps: [
          () => order('processing'),
          lost(),
          () => order('processing', [marker]),
          noteCreated,
        ],
      });

      await expect(execute('customer_confirmation')).resolves.toEqual({
        status: 'applied',
        providerStatus: 'processing',
      });
      expect(methods()).toEqual(['GET', 'PUT', 'GET', 'POST']);
    });

    it('asks for a retry, not a blind rewrite, when it was not taken', async () => {
      const { execute, methods } = setup({
        steps: [() => order('processing'), lost(), () => order('processing')],
      });

      await expect(execute('customer_confirmation')).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'write_unconfirmed',
      });
      // One write, no note: nothing was confirmed.
      expect(methods()).toEqual(['GET', 'PUT', 'GET']);
    });

    it.each([500, 502, 504])('treats a %i as ambiguous too', async (status) => {
      const marker = markerOf('customer_cancellation');
      const { execute, methods } = setup({
        steps: [
          () => order('on-hold'),
          () => answer(status),
          () => order('cancelled', [marker]),
        ],
      });

      await expect(execute('customer_cancellation')).resolves.toMatchObject({
        status: 'applied',
      });
      expect(methods()).toEqual(['GET', 'PUT', 'GET']);
    });

    it('reads the order back when a 200 does not show the write', async () => {
      const marker = markerOf('customer_cancellation');
      const { execute, methods } = setup({
        steps: [
          () => order('processing'),
          () => answer(200, 'OK'),
          () => order('cancelled', [marker]),
        ],
      });

      await expect(execute('customer_cancellation')).resolves.toMatchObject({
        status: 'applied',
      });
      expect(methods()).toEqual(['GET', 'PUT', 'GET']);
    });

    it('does not report a cancellation the store answered 200 to and did not make', async () => {
      const marker = markerOf('customer_cancellation');
      const { execute, methods } = setup({
        steps: [
          () => order('processing'),
          () => order('processing', [marker]),
          () => order('processing', [marker]),
        ],
      });

      await expect(execute('customer_cancellation')).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: 'processing',
      });
      expect(methods()).toEqual(['GET', 'PUT', 'GET']);
    });

    it('never claims success when the read-back fails as well', async () => {
      const { execute } = setup({
        steps: [() => order('processing'), lost(), lost()],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'write_unconfirmed',
      });
    });

    it('keeps the wait a throttled read-back names', async () => {
      const { execute } = setup({
        steps: [
          () => order('processing'),
          lost(),
          () => answer(429, {}, { 'retry-after': '20' }),
        ],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'write_unconfirmed',
        retryAfterMs: 20_000,
      });
    });

    it('stops when the order moved to another state meanwhile', async () => {
      const { execute } = setup({
        steps: [() => order('processing'), lost(), () => order('completed')],
      });

      await expect(execute('customer_cancellation')).resolves.toEqual({
        status: 'permanent_failure',
        errorCode: 'remote_state_conflict',
        providerStatus: 'completed',
      });
    });
  });

  describe('the note', () => {
    it('still reports the confirmation as applied when the note fails', async () => {
      const marker = markerOf('customer_confirmation');
      const { execute, methods } = setup({
        steps: [
          () => order('processing'),
          () => order('processing', [marker]),
          () => answer(500),
        ],
      });

      await expect(execute('customer_confirmation')).resolves.toEqual({
        status: 'applied',
        providerStatus: 'processing',
      });
      // One attempt at the note, never a second.
      expect(methods()).toEqual(['GET', 'PUT', 'POST']);
    });

    it('adds no note on a repeat: the marker is already there', async () => {
      const marker = markerOf('customer_confirmation');
      const first = setup({
        steps: [
          () => order('processing'),
          () => order('processing', [marker]),
          noteCreated,
        ],
      });
      const repeat = setup({ steps: [() => order('processing', [marker])] });

      await first.execute('customer_confirmation');
      await repeat.execute('customer_confirmation');

      expect(
        [...first.methods(), ...repeat.methods()].filter(
          (method) => method === 'POST',
        ),
      ).toHaveLength(1);
      expect(repeat.methods()).toEqual(['GET']);
    });
  });

  describe('throttling and transient failures', () => {
    it.each([
      [429, 'source_rate_limited'],
      [503, 'source_unavailable'],
    ])('honors Retry-After on a %i', async (status, errorCode) => {
      const { execute, methods } = setup({
        steps: [() => answer(status, {}, { 'retry-after': '17' })],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode,
        retryAfterMs: 17_000,
      });
      expect(methods()).toEqual(['GET']);
    });

    it.each([
      [429, 'source_rate_limited'],
      [503, 'source_unavailable'],
    ])(
      'leaves a %i that names no wait to the existing backoff',
      async (status, errorCode) => {
        const { execute } = setup({ steps: [() => answer(status)] });

        await expect(execute()).resolves.toEqual({
          status: 'retryable_failure',
          errorCode,
        });
      },
    );

    it('retries a throttled write without reading back', async () => {
      const { execute, methods } = setup({
        steps: [
          () => order('processing'),
          () => answer(429, {}, { 'retry-after': '5' }),
        ],
      });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'source_rate_limited',
        retryAfterMs: 5_000,
      });
      expect(methods()).toEqual(['GET', 'PUT']);
    });

    it.each(['timeout', 'network'] as const)(
      'retries when the read ends in a %s: nothing was written',
      async (code) => {
        const { execute, methods } = setup({ steps: [lost(code)] });

        await expect(execute()).resolves.toEqual({
          status: 'retryable_failure',
          errorCode: 'source_unavailable',
        });
        expect(methods()).toEqual(['GET']);
      },
    );

    it('retries when the store answers the read with a 5xx', async () => {
      const { execute } = setup({ steps: [() => answer(500)] });

      await expect(execute()).resolves.toEqual({
        status: 'retryable_failure',
        errorCode: 'source_unavailable',
      });
    });
  });

  describe('credentials, permission and the store’s hosting', () => {
    it.each([
      [401, 'source_credentials_rejected', 'credentials_rejected'],
      [403, 'source_permission_denied', 'permission_denied'],
    ])(
      'stops on a %i, flags assisted action and records the health',
      async (status, errorCode, health) => {
        const { execute, connections, methods } = setup({
          steps: [() => answer(status, { message: 'never parsed' })],
        });

        await expect(execute()).resolves.toEqual({
          status: 'permanent_failure',
          errorCode,
          requiresAssistance: true,
        });
        expect(connections.setHealth).toHaveBeenCalledWith(
          'integration-1',
          'org-1',
          health,
        );
        expect(methods()).toEqual(['GET']);
      },
    );

    it('stops on a key revoked between the read and the write', async () => {
      const { execute, connections, methods } = setup({
        steps: [() => order('processing'), () => answer(401)],
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
      expect(methods()).toEqual(['GET', 'PUT']);
    });

    it('clears a stale health state once the keys work again', async () => {
      const { execute, connections } = setup({
        connection: { health: 'credentials_rejected' },
        steps: [() => order('processing', [markerOf('customer_confirmation')])],
      });

      await execute();

      expect(connections.setHealth).toHaveBeenCalledWith(
        'integration-1',
        'org-1',
        'ok',
      );
    });

    it('leaves a healthy connection’s health alone', async () => {
      const { execute, connections } = setup({
        steps: [() => order('processing', [markerOf('customer_confirmation')])],
      });

      await execute();

      expect(connections.setHealth).not.toHaveBeenCalled();
    });

    it.each([405, 501])(
      'flags a host that answers the write with %i as needing assistance',
      async (status) => {
        const { execute, methods } = setup({
          steps: [() => order('processing'), () => answer(status)],
        });

        await expect(execute()).resolves.toEqual({
          status: 'permanent_failure',
          errorCode: 'store_write_method_refused',
          requiresAssistance: true,
        });
        expect(methods()).toEqual(['GET', 'PUT']);
      },
    );

    it.each([400, 409, 422])(
      'reports a change the store refuses with %i as permanent',
      async (status) => {
        const { execute, methods } = setup({
          steps: [() => order('processing'), () => answer(status)],
        });

        await expect(execute('customer_cancellation')).resolves.toEqual({
          status: 'permanent_failure',
          errorCode: 'remote_rejected',
        });
        expect(methods()).toEqual(['GET', 'PUT']);
      },
    );

    it.each(['address_not_public', 'redirect', 'tls_failed'] as const)(
      'flags a store the restricted client refuses (%s) as needing assistance',
      async (code) => {
        const refuse: Step = () =>
          Promise.reject(new RestrictedHttpError(code, 'shop.example.com'));
        const onRead = setup({ steps: [refuse] });
        const onWrite = setup({ steps: [() => order('processing'), refuse] });

        for (const { execute } of [onRead, onWrite])
          await expect(execute()).resolves.toEqual({
            status: 'permanent_failure',
            errorCode: 'store_unreachable',
            requiresAssistance: true,
          });
        // Refused before the request was carried: no read-back.
        expect(onWrite.methods()).toEqual(['GET', 'PUT']);
      },
    );
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
      ['key is not an envelope', { consumerKeyEncrypted: 'v1:not-real' }],
      [
        'secret is not an envelope',
        { consumerSecretEncrypted: 'plain-text-secret' },
      ],
      [
        'key was sealed with another key',
        { consumerKeyEncrypted: encryptToken(CONSUMER_KEY, 'x'.repeat(32)) },
      ],
    ])(
      'flags assisted action when the stored %s',
      async (_label, connection) => {
        const { execute, requests } = setup({ connection });

        await expect(execute()).resolves.toEqual({
          status: 'permanent_failure',
          errorCode: 'credentials_unreadable',
          requiresAssistance: true,
        });
        expect(requests).toHaveLength(0);
      },
    );

    it('builds every request from the stored store URL of the order’s own integration', async () => {
      const marker = markerOf('customer_confirmation');
      const { execute, requests } = setup({
        connection: { storeUrl: 'https://shop.example.com/store' },
        steps: [
          () =>
            order(
              'processing',
              [],
              'https://shop.example.com/store/wp-json/wc/v3/orders/1001',
            ),
          () =>
            order(
              'processing',
              [marker],
              'https://shop.example.com/store/wp-json/wc/v3/orders/1001',
            ),
          noteCreated,
        ],
      });

      await execute();

      expect(requests.map((request) => request.url)).toEqual([
        'https://shop.example.com/store/wp-json/wc/v3/orders/1001',
        'https://shop.example.com/store/wp-json/wc/v3/orders/1001',
        'https://shop.example.com/store/wp-json/wc/v3/orders/1001/notes',
      ]);
    });
  });
});
