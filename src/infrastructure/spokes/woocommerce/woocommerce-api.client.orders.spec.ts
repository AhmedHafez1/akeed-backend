import {
  RestrictedHttpError,
  type RestrictedHttpErrorCode,
  type RestrictedHttpRequest,
  type RestrictedHttpResponse,
} from '../../../shared/http/restricted-http';
import {
  parseRetryAfter,
  WooCommerceApiClient,
} from './woocommerce-api.client';

const STORE = 'https://example.com/shop';
const ORDER_ID = '1001';
const ORDER_URL = `${STORE}/wp-json/wc/v3/orders/${ORDER_ID}`;
const MARKER = 'customer_confirmation:verification-1';
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

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    status: 'processing',
    meta_data: [],
    billing: { email: 'never.read@example.com' },
    _links: { self: [{ href: ORDER_URL }] },
    ...overrides,
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

describe('WooCommerceApiClient order calls', () => {
  describe('getOrder', () => {
    it('reads the order with Basic authentication, and keeps only the status and the markers', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(
          200,
          order({
            status: 'on-hold',
            meta_data: [
              { id: 1, key: 'akeed_outcome', value: MARKER },
              { id: 2, key: '_other_plugin', value: 'ignored' },
            ],
          }),
        ),
      );

      await expect(
        client.getOrder(STORE, credentials, ORDER_ID),
      ).resolves.toEqual({
        kind: 'found',
        order: { status: 'on-hold', markers: [MARKER] },
      });
      expect(requests).toEqual([
        { url: ORDER_URL, method: 'GET', authorization: BASIC },
      ]);
      expect(requests[0].url).not.toMatch(/ck_|cs_|consumer/);
    });

    it('reads a status that is not a status name as none', async () => {
      const { client } = clientAnswering(() =>
        answer(200, order({ status: 'on its way' })),
      );

      await expect(
        client.getOrder(STORE, credentials, ORDER_ID),
      ).resolves.toEqual({
        kind: 'found',
        order: { status: null, markers: [] },
      });
    });

    it('accepts the link of a store at a domain root', async () => {
      const { client } = clientAnswering(() =>
        answer(
          200,
          order({
            _links: {
              self: [{ href: 'https://example.com/wp-json/wc/v3/orders/1001' }],
            },
          }),
        ),
      );

      await expect(
        client.getOrder('https://example.com', credentials, ORDER_ID),
      ).resolves.toMatchObject({ kind: 'found' });
    });

    it.each([
      ['another order id', order({ id: 1002 })],
      ['a text id', order({ id: '1001' })],
      ['no link', order({ _links: undefined })],
      ['an empty link list', order({ _links: { self: [] } })],
      [
        'the link of another host',
        order({
          _links: {
            self: [
              { href: 'https://other.example/shop/wp-json/wc/v3/orders/1001' },
            ],
          },
        }),
      ],
      [
        'the link of the store at the domain root',
        order({
          _links: {
            self: [{ href: 'https://example.com/wp-json/wc/v3/orders/1001' }],
          },
        }),
      ],
      [
        'the link of a store one directory deeper',
        order({
          _links: {
            self: [
              {
                href: 'https://example.com/shop/eu/wp-json/wc/v3/orders/1001',
              },
            ],
          },
        }),
      ],
      [
        'the link of another order',
        order({
          _links: { self: [{ href: `${STORE}/wp-json/wc/v3/orders/1002` }] },
        }),
      ],
      [
        'a plain-HTTP link',
        order({
          _links: {
            self: [
              { href: 'http://example.com/shop/wp-json/wc/v3/orders/1001' },
            ],
          },
        }),
      ],
      [
        'a link with a query',
        order({ _links: { self: [{ href: `${ORDER_URL}?x=1` }] } }),
      ],
      ['a JSON array', [order()]],
      ['a body that is not JSON', '<html>maintenance</html>'],
    ])('fails closed on %s', async (_label, body) => {
      const { client } = clientAnswering(() => answer(200, body));

      await expect(
        client.getOrder(STORE, credentials, ORDER_ID),
      ).resolves.toEqual({ kind: 'unverified' });
    });

    it.each([
      [401, { kind: 'credentials_rejected' }],
      [403, { kind: 'permission_denied' }],
      [404, { kind: 'not_found' }],
      [429, { kind: 'throttled', status: 429, retryAfterMs: null }],
      [503, { kind: 'throttled', status: 503, retryAfterMs: null }],
      [400, { kind: 'unavailable' }],
      [500, { kind: 'unavailable' }],
      [502, { kind: 'unavailable' }],
      [204, { kind: 'unverified' }],
    ])(
      'reports %i without reading what the store said',
      async (status, expected) => {
        const { client } = clientAnswering(() =>
          answer(status, { code: 'x', message: 'text that is never parsed' }),
        );

        await expect(
          client.getOrder(STORE, credentials, ORDER_ID),
        ).resolves.toEqual(expected);
      },
    );

    it('carries the wait a throttled answer names', async () => {
      const { client } = clientAnswering(() =>
        answer(429, '', { 'retry-after': '30' }),
      );

      await expect(
        client.getOrder(STORE, credentials, ORDER_ID),
      ).resolves.toEqual({
        kind: 'throttled',
        status: 429,
        retryAfterMs: 30_000,
      });
    });

    it.each([
      ['timeout', 'unavailable'],
      ['network', 'unavailable'],
      ['address_not_public', 'refused'],
      ['redirect', 'refused'],
      ['tls_failed', 'refused'],
      ['response_too_large', 'refused'],
      ['https_required', 'refused'],
      ['invalid_url', 'refused'],
    ] as const)(
      'reports the restricted client failing with %s as %s',
      async (code, kind) => {
        const { client } = clientAnswering(() => refusedBy(code));

        await expect(
          client.getOrder(STORE, credentials, ORDER_ID),
        ).resolves.toEqual({ kind });
      },
    );

    it('never throws, whatever the transport does', async () => {
      const { client } = clientAnswering(() => new Error('boom'));

      await expect(
        client.getOrder(STORE, credentials, ORDER_ID),
      ).resolves.toEqual({ kind: 'unavailable' });
    });

    it.each(['', '0', '-1', '1001/notes', '../1001', '1e3', '1001?x=1'])(
      'sends nothing for an order id that is not decimal (%p)',
      async (orderId) => {
        const { client, requests } = clientAnswering(() => answer(200));

        await expect(
          client.getOrder(STORE, credentials, orderId),
        ).resolves.toEqual({ kind: 'not_found' });
        await expect(
          client.updateOrder(STORE, credentials, orderId, { marker: MARKER }),
        ).resolves.toEqual({ kind: 'not_found' });
        await expect(
          client.addOrderNote(STORE, credentials, orderId, 'note'),
        ).resolves.toBe(false);
        expect(requests).toHaveLength(0);
      },
    );
  });

  describe('updateOrder', () => {
    const written = (status: string) =>
      order({
        status,
        meta_data: [{ id: 9, key: 'akeed_outcome', value: MARKER }],
      });

    it('writes the marker alone when the outcome changes no status', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(200, written('processing')),
      );

      await expect(
        client.updateOrder(STORE, credentials, ORDER_ID, { marker: MARKER }),
      ).resolves.toEqual({
        kind: 'updated',
        order: { status: 'processing', markers: [MARKER] },
      });
      expect(requests[0]).toMatchObject({
        url: ORDER_URL,
        method: 'PUT',
        authorization: BASIC,
        contentType: 'application/json',
      });
      expect(JSON.parse(requests[0].body!)).toEqual({
        meta_data: [{ key: 'akeed_outcome', value: MARKER }],
      });
    });

    it('writes the status and the marker in one update', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(200, written('cancelled')),
      );

      await client.updateOrder(STORE, credentials, ORDER_ID, {
        marker: MARKER,
        status: 'cancelled',
      });

      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0].body!)).toEqual({
        status: 'cancelled',
        meta_data: [{ key: 'akeed_outcome', value: MARKER }],
      });
    });

    it('never asks the store to mark the order paid', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(200, written('cancelled')),
      );

      await client.updateOrder(STORE, credentials, ORDER_ID, {
        marker: MARKER,
        status: 'cancelled',
      });

      expect(requests[0].body).not.toMatch(/set_paid|_method/);
      expect(requests[0].url).not.toContain('_method');
    });

    it.each([
      [401, { kind: 'credentials_rejected' }],
      [403, { kind: 'permission_denied' }],
      [404, { kind: 'not_found' }],
      [429, { kind: 'throttled', status: 429, retryAfterMs: null }],
      [503, { kind: 'throttled', status: 503, retryAfterMs: null }],
      [400, { kind: 'rejected' }],
      [409, { kind: 'rejected' }],
      [422, { kind: 'rejected' }],
      [405, { kind: 'method_refused' }],
      [501, { kind: 'method_refused' }],
      [500, { kind: 'ambiguous' }],
      [502, { kind: 'ambiguous' }],
      [504, { kind: 'ambiguous' }],
    ])('reports %i', async (status, expected) => {
      const { client } = clientAnswering(() => answer(status));

      await expect(
        client.updateOrder(STORE, credentials, ORDER_ID, { marker: MARKER }),
      ).resolves.toEqual(expected);
    });

    it.each([
      ['a body that is not JSON', 'OK'],
      ['another order', order({ id: 1002 })],
      ['an order of another store', order({ _links: { self: [] } })],
    ])(
      'does not take a 200 with %s as proof of the write',
      async (_label, body) => {
        const { client } = clientAnswering(() => answer(200, body));

        await expect(
          client.updateOrder(STORE, credentials, ORDER_ID, { marker: MARKER }),
        ).resolves.toEqual({ kind: 'ambiguous' });
      },
    );

    it.each([
      // The request may have left: the order has to be read.
      ['timeout', 'ambiguous'],
      ['network', 'ambiguous'],
      ['response_too_large', 'ambiguous'],
      // Refused before any request was carried, or answered by a redirect.
      ['address_not_public', 'refused'],
      ['redirect', 'refused'],
      ['tls_failed', 'refused'],
      ['https_required', 'refused'],
      ['invalid_url', 'refused'],
    ] as const)(
      'reports the restricted client failing with %s as %s',
      async (code, kind) => {
        const { client } = clientAnswering(() => refusedBy(code));

        await expect(
          client.updateOrder(STORE, credentials, ORDER_ID, { marker: MARKER }),
        ).resolves.toEqual({ kind });
      },
    );

    it('treats an unknown transport failure as ambiguous', async () => {
      const { client } = clientAnswering(() => new Error('boom'));

      await expect(
        client.updateOrder(STORE, credentials, ORDER_ID, { marker: MARKER }),
      ).resolves.toEqual({ kind: 'ambiguous' });
    });
  });

  describe('addOrderNote', () => {
    it('adds one internal note the customer is not shown', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(201, { id: 281 }),
      );

      await expect(
        client.addOrderNote(STORE, credentials, ORDER_ID, 'Fixed text.'),
      ).resolves.toBe(true);
      expect(requests[0]).toMatchObject({
        url: `${ORDER_URL}/notes`,
        method: 'POST',
        authorization: BASIC,
        contentType: 'application/json',
      });
      expect(JSON.parse(requests[0].body!)).toEqual({
        note: 'Fixed text.',
        customer_note: false,
      });
    });

    it.each([400, 401, 403, 404, 429, 500])(
      'says so when the store answers %i',
      async (status) => {
        const { client } = clientAnswering(() => answer(status));

        await expect(
          client.addOrderNote(STORE, credentials, ORDER_ID, 'Fixed text.'),
        ).resolves.toBe(false);
      },
    );

    it('says so, without throwing, when there is no answer', async () => {
      const { client } = clientAnswering(() => refusedBy('timeout'));

      await expect(
        client.addOrderNote(STORE, credentials, ORDER_ID, 'Fixed text.'),
      ).resolves.toBe(false);
    });
  });

  describe('parseRetryAfter', () => {
    const NOW = Date.parse('2026-10-04T10:00:00Z');

    it.each([
      ['0', 0],
      ['17', 17_000],
      [' 30 ', 30_000],
      // Kept as it is: the outcome sync policy clamps a long wait.
      ['3600', 3_600_000],
      ['Sun, 04 Oct 2026 10:02:00 GMT', 120_000],
    ])('reads %p', (header, expected) => {
      expect(parseRetryAfter(header, NOW)).toBe(expected);
    });

    it.each([
      undefined,
      '',
      'soon',
      '-5',
      '1.5',
      '9999999999',
      'Sun, 04 Oct 2026 09:00:00 GMT',
    ])('does not believe %p', (header) => {
      expect(parseRetryAfter(header, NOW)).toBeNull();
    });
  });
});
