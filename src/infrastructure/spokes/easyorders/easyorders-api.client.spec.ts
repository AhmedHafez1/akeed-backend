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
