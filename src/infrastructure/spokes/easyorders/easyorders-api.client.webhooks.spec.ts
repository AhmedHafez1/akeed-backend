import {
  EasyOrdersApiClient,
  type EasyOrdersHttp,
} from './easyorders-api.client';

const WEBHOOK_URL =
  'https://api.akeed.test/webhooks/easyorders/orders/token-under-test';

function clientAnswering(...responses: (() => Promise<Response>)[]) {
  const http = jest.fn<
    ReturnType<EasyOrdersHttp>,
    Parameters<EasyOrdersHttp>
  >();
  for (const response of responses) http.mockImplementationOnce(response);
  return { http, client: new EasyOrdersApiClient(http) };
}

const answer = (status: number) => () =>
  Promise.resolve(new Response(status === 204 ? null : '', { status }));

describe('EasyOrdersApiClient.deleteWebhookByUrl', () => {
  it('sends one DELETE for the address, with the key in the Api-Key header and a deadline', async () => {
    const { http, client } = clientAnswering(answer(200));

    await expect(
      client.deleteWebhookByUrl('key-under-test', WEBHOOK_URL),
    ).resolves.toBe('removed');

    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(
      `https://api.easy-orders.net/api/v1/external-apps/webhooks/delete-by-url?url=${encodeURIComponent(WEBHOOK_URL)}`,
    );
    expect(url).not.toContain('key-under-test');
    expect(init?.method).toBe('DELETE');
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('Api-Key')).toBe('key-under-test');
    expect(headers.has('Authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403])(
    'tries once more as a bearer token when Api-Key answers %i',
    async (status) => {
      const { http, client } = clientAnswering(answer(status), answer(204));

      await expect(
        client.deleteWebhookByUrl('key-under-test', WEBHOOK_URL),
      ).resolves.toBe('removed');

      expect(http).toHaveBeenCalledTimes(2);
      const headers = new Headers(http.mock.calls[1][1]?.headers);
      expect(headers.get('Authorization')).toBe('Bearer key-under-test');
      expect(headers.has('Api-Key')).toBe(false);
    },
  );

  it('reports a key refused under both headers as rejected, after two requests', async () => {
    const { http, client } = clientAnswering(answer(401), answer(401));

    await expect(
      client.deleteWebhookByUrl('key-under-test', WEBHOOK_URL),
    ).resolves.toBe('rejected');
    expect(http).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, 'not_found'],
    [400, 'rejected'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])(
    'classifies a %i as %s, without a second request',
    async (status, kind) => {
      const { http, client } = clientAnswering(answer(status));

      await expect(
        client.deleteWebhookByUrl('key-under-test', WEBHOOK_URL),
      ).resolves.toBe(kind);
      expect(http).toHaveBeenCalledTimes(1);
    },
  );

  it('never retries, and reports a lost answer as unavailable', async () => {
    const { http, client } = clientAnswering(() =>
      Promise.reject(new Error('socket hang up')),
    );

    await expect(
      client.deleteWebhookByUrl('key-under-test', WEBHOOK_URL),
    ).resolves.toBe('unavailable');
    expect(http).toHaveBeenCalledTimes(1);
  });
});
