import {
  RESTRICTED_HTTP_MAX_BYTES,
  RestrictedHttpError,
  type RestrictedHttpErrorCode,
  type RestrictedHttpRequest,
  type RestrictedHttpResponse,
} from '../../../shared/http/restricted-http';
import { WooCommerceApiClient } from './woocommerce-api.client';

const STORE = 'https://example.com/shop';
const credentials = {
  consumerKey: 'ck_synthetic',
  consumerSecret: 'cs_synthetic',
};
const BASIC = `Basic ${Buffer.from('ck_synthetic:cs_synthetic').toString('base64')}`;

function answer(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): RestrictedHttpResponse {
  return {
    status,
    headers,
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function clientAnswering(
  respond: (request: RestrictedHttpRequest) => RestrictedHttpResponse | Error,
) {
  const requests: RestrictedHttpRequest[] = [];
  const client = new WooCommerceApiClient((request) => {
    requests.push(request);
    const result = respond(request);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  });
  return { client, requests };
}

const refusedBy = (code: RestrictedHttpErrorCode) =>
  new RestrictedHttpError(code, 'example.com');

describe('WooCommerceApiClient', () => {
  describe('probeRestApi', () => {
    it('sends one unauthenticated GET to the REST base of the store', async () => {
      const { client, requests } = clientAnswering(() => answer(200));

      await expect(client.probeRestApi(STORE)).resolves.toEqual({ kind: 'ok' });
      expect(requests).toEqual([
        { url: `${STORE}/wp-json/wc/v3`, method: 'GET' },
      ]);
    });

    it.each([
      [200, 'ok'],
      [400, 'ok'],
      [401, 'ok'],
      [403, 'ok'],
      [429, 'ok'],
      [404, 'rest_not_found'],
      [500, 'unreachable'],
      [502, 'unreachable'],
      [503, 'unreachable'],
    ])('reads only the status: %i is %s', async (status, expected) => {
      // Not JSON on purpose: the body is never read at start.
      const { client } = clientAnswering(() => answer(status, '<html>'));

      const result = await client.probeRestApi(STORE);

      expect(result.kind === 'ok' ? 'ok' : result.reason).toBe(expected);
    });

    it.each([
      ['address_not_public', 'address_not_public'],
      ['redirect', 'redirects'],
      ['tls_failed', 'tls_failed'],
      ['timeout', 'unreachable'],
      ['network', 'unreachable'],
      ['response_too_large', 'unreachable'],
      ['https_required', 'unreachable'],
      ['invalid_url', 'unreachable'],
    ] as const)(
      'reports the restricted client refusing with %s as %s',
      async (code, reason) => {
        const { client } = clientAnswering(() => refusedBy(code));

        await expect(client.probeRestApi(STORE)).resolves.toEqual({
          kind: 'failed',
          reason,
        });
      },
    );

    it('never throws, whatever the transport does', async () => {
      const { client } = clientAnswering(() => new Error('boom'));

      await expect(client.probeRestApi(STORE)).resolves.toEqual({
        kind: 'failed',
        reason: 'unreachable',
      });
    });
  });

  describe('readSystemStatus', () => {
    const status = (environment: unknown) => answer(200, { environment });

    it('proves the keys with Basic authentication and the larger body cap', async () => {
      const budget = new AbortController().signal;
      const { client, requests } = clientAnswering(() =>
        status({ home_url: 'https://example.com/shop', version: '9.8.1' }),
      );

      await expect(
        client.readSystemStatus(STORE, credentials, budget),
      ).resolves.toEqual({
        kind: 'ok',
        homeUrl: 'https://example.com/shop',
        version: '9.8.1',
      });
      expect(requests).toEqual([
        {
          url: `${STORE}/wp-json/wc/v3/system_status`,
          method: 'GET',
          authorization: BASIC,
          maxResponseBytes: RESTRICTED_HTTP_MAX_BYTES,
          signal: budget,
        },
      ]);
      // Never in the URL.
      expect(requests[0].url).not.toMatch(/ck_|cs_|consumer/);
    });

    it('keeps no version that is not text', async () => {
      const { client } = clientAnswering(() =>
        status({ home_url: 'https://example.com', version: 9 }),
      );

      await expect(
        client.readSystemStatus(STORE, credentials),
      ).resolves.toMatchObject({ kind: 'ok', version: null });
    });

    it.each([
      [401, 'credentials_rejected'],
      [403, 'permission_denied'],
      [404, 'rest_not_found'],
      [429, 'unreachable'],
      [500, 'unreachable'],
      [201, 'unreachable'],
    ])('reports %i as %s', async (httpStatus, reason) => {
      const { client } = clientAnswering(() =>
        answer(httpStatus, {
          code: 'woocommerce_rest_cannot_view',
          message: 'text that is never parsed',
        }),
      );

      await expect(
        client.readSystemStatus(STORE, credentials),
      ).resolves.toEqual({ kind: 'failed', reason });
    });

    it.each([
      ['a body that is not JSON', '<html>maintenance</html>'],
      ['a JSON array', []],
      ['no environment', { settings: {} }],
      ['an environment that is not an object', { environment: 'x' }],
      ['no home_url', { environment: { site_url: 'https://example.com' } }],
      ['a home_url that is not text', { environment: { home_url: 7 } }],
    ])('does not accept a 200 with %s as proof', async (_label, body) => {
      const { client } = clientAnswering(() => answer(200, body));

      await expect(
        client.readSystemStatus(STORE, credentials),
      ).resolves.toEqual({ kind: 'failed', reason: 'unreachable' });
    });

    it("tells the caller's spent budget from a store that did not answer in time", async () => {
      const spent = AbortSignal.abort();
      const { client } = clientAnswering(() => refusedBy('timeout'));

      await expect(
        client.readSystemStatus(STORE, credentials, spent),
      ).resolves.toEqual({ kind: 'failed', reason: 'budget_exceeded' });
      await expect(
        client.readSystemStatus(
          STORE,
          credentials,
          new AbortController().signal,
        ),
      ).resolves.toEqual({ kind: 'failed', reason: 'unreachable' });
    });
  });

  describe('listWebhooks', () => {
    it('reads one page of 100 and the total the store states', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(
          200,
          [
            { id: 7, delivery_url: 'https://a.example/hook', secret: 'never' },
            { id: 8, delivery_url: 'https://b.example/hook' },
          ],
          { 'x-wp-totalpages': '3' },
        ),
      );

      await expect(client.listWebhooks(STORE, credentials, 2)).resolves.toEqual(
        {
          kind: 'ok',
          webhooks: [
            { id: 7, deliveryUrl: 'https://a.example/hook' },
            { id: 8, deliveryUrl: 'https://b.example/hook' },
          ],
          totalPages: 3,
        },
      );
      expect(requests[0]).toMatchObject({
        url: `${STORE}/wp-json/wc/v3/webhooks?per_page=100&page=2`,
        method: 'GET',
        authorization: BASIC,
      });
    });

    it('says so when the store states no total', async () => {
      const { client } = clientAnswering(() => answer(200, []));

      await expect(client.listWebhooks(STORE, credentials, 1)).resolves.toEqual(
        { kind: 'ok', webhooks: [], totalPages: null },
      );
    });

    it.each([
      ['an object instead of a list', { webhooks: [] }],
      ['an entry without an id', [{ delivery_url: 'https://a.example' }]],
      ['an entry with a text id', [{ id: '7', delivery_url: 'https://a' }]],
      ['an entry without an address', [{ id: 7 }]],
      ['an entry that is not an object', ['x']],
    ])('fails closed on %s', async (_label, body) => {
      const { client } = clientAnswering(() => answer(200, body));

      await expect(client.listWebhooks(STORE, credentials, 1)).resolves.toEqual(
        { kind: 'failed', reason: 'unreachable' },
      );
    });

    it.each([
      [401, 'credentials_rejected'],
      [403, 'permission_denied'],
      [500, 'unreachable'],
    ])('reports %i as %s', async (httpStatus, reason) => {
      const { client } = clientAnswering(() => answer(httpStatus));

      await expect(client.listWebhooks(STORE, credentials, 1)).resolves.toEqual(
        { kind: 'failed', reason },
      );
    });
  });

  describe('createWebhook', () => {
    const webhook = {
      name: 'Akeed order created',
      topic: 'order.created',
      deliveryUrl: 'https://api.akeed.test/api/woocommerce/webhooks/tok',
      secret: 'install-secret',
    };

    it('creates an active webhook with the secret in the body only', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(201, { id: 142, status: 'active' }),
      );

      await expect(
        client.createWebhook(STORE, credentials, webhook),
      ).resolves.toEqual({ kind: 'ok', id: 142 });
      expect(requests[0]).toMatchObject({
        url: `${STORE}/wp-json/wc/v3/webhooks`,
        method: 'POST',
        authorization: BASIC,
        contentType: 'application/json',
      });
      expect(JSON.parse(requests[0].body!)).toEqual({
        name: 'Akeed order created',
        status: 'active',
        topic: 'order.created',
        delivery_url: 'https://api.akeed.test/api/woocommerce/webhooks/tok',
        secret: 'install-secret',
      });
      expect(requests[0].url).not.toContain('install-secret');
    });

    it.each([
      ['no id', {}],
      ['a text id', { id: '142' }],
      ['a zero id', { id: 0 }],
      ['a fractional id', { id: 1.5 }],
      ['a body that is not JSON', 'created'],
    ])('does not count a 201 with %s as created', async (_label, body) => {
      const { client } = clientAnswering(() => answer(201, body));

      await expect(
        client.createWebhook(STORE, credentials, webhook),
      ).resolves.toEqual({ kind: 'failed', reason: 'unreachable' });
    });

    it.each([
      [400, 'unreachable'],
      [401, 'credentials_rejected'],
      [403, 'permission_denied'],
      [405, 'unreachable'],
      [500, 'unreachable'],
      [501, 'unreachable'],
    ])('reports %i as %s', async (httpStatus, reason) => {
      const { client } = clientAnswering(() => answer(httpStatus));

      await expect(
        client.createWebhook(STORE, credentials, webhook),
      ).resolves.toEqual({ kind: 'failed', reason });
    });
  });

  describe('deleteWebhook', () => {
    it('deletes for good, and counts a webhook that is already gone as deleted', async () => {
      const { client, requests } = clientAnswering(() => answer(200));
      const gone = clientAnswering(() => answer(404));

      await expect(
        client.deleteWebhook(STORE, credentials, 142),
      ).resolves.toEqual({ kind: 'ok' });
      await expect(
        gone.client.deleteWebhook(STORE, credentials, 142),
      ).resolves.toEqual({ kind: 'ok' });
      expect(requests[0]).toMatchObject({
        url: `${STORE}/wp-json/wc/v3/webhooks/142?force=true`,
        method: 'DELETE',
        authorization: BASIC,
      });
    });

    it.each([
      [401, 'credentials_rejected'],
      [403, 'permission_denied'],
      [405, 'unreachable'],
      [501, 'unreachable'],
    ])('reports %i as %s', async (httpStatus, reason) => {
      const { client } = clientAnswering(() => answer(httpStatus));

      await expect(
        client.deleteWebhook(STORE, credentials, 142),
      ).resolves.toEqual({ kind: 'failed', reason });
    });
  });
});
