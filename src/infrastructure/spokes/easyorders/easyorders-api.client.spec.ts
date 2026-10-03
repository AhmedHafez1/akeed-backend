import {
  EASYORDERS_INACTIVE_STORE_MESSAGE,
  EasyOrdersApiClient,
  parseRetryAfter,
  type EasyOrdersHttp,
} from './easyorders-api.client';

function clientAnswering(response: () => Promise<Response>) {
  const http = jest.fn<ReturnType<EasyOrdersHttp>, Parameters<EasyOrdersHttp>>(
    response,
  );
  return { http, client: new EasyOrdersApiClient(http) };
}

describe('EasyOrdersApiClient.probeKey', () => {
  it('reads an order that cannot exist, with the key in the Api-Key header and a deadline', async () => {
    const { http, client } = clientAnswering(() =>
      Promise.resolve(Response.json({})),
    );

    await client.probeKey('key-under-test');

    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toMatch(
      /^https:\/\/api\.easy-orders\.net\/api\/v1\/external-apps\/orders\/[0-9a-f-]{36}$/,
    );
    expect(url).not.toContain('key-under-test');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Api-Key')).toBe('key-under-test');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a 200', () => Response.json({ id: 'order' }), 'live'],
    [
      'the inactive-store 400',
      () =>
        Response.json(
          { message: EASYORDERS_INACTIVE_STORE_MESSAGE },
          { status: 400 },
        ),
      'store_inactive',
    ],
    [
      'another 400',
      () => Response.json({ message: 'Bad request' }, { status: 400 }),
      'rejected',
    ],
    [
      'a 400 without a JSON body',
      () => new Response('nope', { status: 400 }),
      'rejected',
    ],
    ['a 401', () => new Response('', { status: 401 }), 'rejected'],
    ['a 403', () => new Response('', { status: 403 }), 'rejected'],
    // Fail closed: the record does not say what a wrong key answers, so an
    // unknown order is not accepted as proof of a recognized key.
    ['a 404', () => new Response('', { status: 404 }), 'rejected'],
    ['a 429', () => new Response('', { status: 429 }), 'unavailable'],
    ['a 500', () => new Response('', { status: 500 }), 'unavailable'],
    ['a 503', () => new Response('', { status: 503 }), 'unavailable'],
  ])('treats %s as %s', async (_label, response, expected) => {
    const { client } = clientAnswering(() => Promise.resolve(response()));

    await expect(client.probeKey('key')).resolves.toBe(expected);
  });

  it('reports a network failure or a timeout as no verdict, in one attempt', async () => {
    const { http, client } = clientAnswering(() =>
      Promise.reject(new DOMException('timed out', 'TimeoutError')),
    );

    await expect(client.probeKey('key')).resolves.toBe('unavailable');
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe('EasyOrdersApiClient.getOrder', () => {
  it('reads the order by id with the key in the Api-Key header and a deadline', async () => {
    const { http, client } = clientAnswering(() =>
      Promise.resolve(Response.json({ id: 'order 1', store_id: 'store-1' })),
    );

    const result = await client.getOrder('key-under-test', 'order 1');

    expect(result).toEqual({
      kind: 'found',
      order: { id: 'order 1', store_id: 'store-1' },
    });
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(
      'https://api.easy-orders.net/api/v1/external-apps/orders/order%201',
    );
    expect(new Headers(init?.headers).get('Api-Key')).toBe('key-under-test');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a 404', () => new Response('', { status: 404 }), { kind: 'not_found' }],
    [
      'a 401',
      () => new Response('', { status: 401 }),
      { kind: 'credentials_rejected' },
    ],
    [
      'a 403',
      () => new Response('', { status: 403 }),
      { kind: 'credentials_rejected' },
    ],
    [
      'the inactive-store 400',
      () =>
        Response.json(
          { message: EASYORDERS_INACTIVE_STORE_MESSAGE },
          { status: 400 },
        ),
      { kind: 'store_inactive' },
    ],
    [
      'another 400',
      () => Response.json({ message: 'Bad request' }, { status: 400 }),
      { kind: 'unavailable' },
    ],
    [
      'a 429 without Retry-After',
      () => new Response('', { status: 429 }),
      { kind: 'rate_limited', retryAfterMs: null },
    ],
    [
      'a 429 with Retry-After',
      () => new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
      { kind: 'rate_limited', retryAfterMs: 7_000 },
    ],
    ['a 500', () => new Response('', { status: 500 }), { kind: 'unavailable' }],
    [
      'a 200 that is not an object',
      () => Response.json(['order']),
      { kind: 'unavailable' },
    ],
  ])('answers %s', async (_label, response, expected) => {
    const { client } = clientAnswering(() => Promise.resolve(response()));

    await expect(client.getOrder('key', 'order-1')).resolves.toEqual(expected);
  });

  it('tries once and reports a network failure as unavailable', async () => {
    const { http, client } = clientAnswering(() =>
      Promise.reject(new Error('socket hang up')),
    );

    await expect(client.getOrder('key', 'order-1')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-03T10:00:00.000Z');

  it.each([
    ['30', 30_000],
    ['Sat, 03 Oct 2026 10:00:20 GMT', 20_000],
    [null, null],
    ['', null],
    ['soon', null],
    ['Sat, 03 Oct 2026 09:00:00 GMT', null],
    ['86400', null],
  ])('reads %j as %j', (header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });
});
