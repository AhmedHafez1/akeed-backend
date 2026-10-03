import {
  EASYORDERS_INACTIVE_STORE_MESSAGE,
  EasyOrdersApiClient,
  type EasyOrdersHttp,
} from './easyorders-api.client';

function clientAnswering(response: () => Promise<Response>) {
  const http = jest.fn<ReturnType<EasyOrdersHttp>, Parameters<EasyOrdersHttp>>(
    response,
  );
  return { http, client: new EasyOrdersApiClient(http) };
}

describe('EasyOrdersApiClient.updateOrderStatus', () => {
  it('sends one PATCH with the status, the key in the header and a deadline', async () => {
    const { http, client } = clientAnswering(() =>
      Promise.resolve(Response.json({})),
    );

    await expect(
      client.updateOrderStatus('key-under-test', 'order/1', 'confirmed'),
    ).resolves.toEqual({ kind: 'updated' });

    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(
      'https://api.easy-orders.net/api/v1/external-apps/orders/order%2F1/status',
    );
    expect(url).not.toContain('key-under-test');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"status":"confirmed"}');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Api-Key')).toBe('key-under-test');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a 204', () => new Response(null, { status: 204 }), { kind: 'updated' }],
    ['a 500', () => new Response('', { status: 500 }), { kind: 'ambiguous' }],
    ['a 503', () => new Response('', { status: 503 }), { kind: 'ambiguous' }],
    [
      'a 429 without Retry-After',
      () => new Response('', { status: 429 }),
      { kind: 'rate_limited', retryAfterMs: null },
    ],
    [
      'a 429 with Retry-After',
      () => new Response('', { status: 429, headers: { 'Retry-After': '9' } }),
      { kind: 'rate_limited', retryAfterMs: 9_000 },
    ],
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
    ['a 404', () => new Response('', { status: 404 }), { kind: 'not_found' }],
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
      () => Response.json({ message: 'Invalid status' }, { status: 400 }),
      { kind: 'rejected' },
    ],
    ['a 422', () => new Response('', { status: 422 }), { kind: 'rejected' }],
  ])('answers %s', async (_label, response, expected) => {
    const { client } = clientAnswering(() => Promise.resolve(response()));

    await expect(
      client.updateOrderStatus('key', 'order-1', 'canceled'),
    ).resolves.toEqual(expected);
  });

  it('never retries, and reports a lost answer as ambiguous', async () => {
    const { http, client } = clientAnswering(() =>
      Promise.reject(new DOMException('timed out', 'TimeoutError')),
    );

    await expect(
      client.updateOrderStatus('key', 'order-1', 'confirmed'),
    ).resolves.toEqual({ kind: 'ambiguous' });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
