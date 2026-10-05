import {
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

function answer(status: number, body: unknown = {}): RestrictedHttpResponse {
  return {
    status,
    headers: {},
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

/** Reading and re-enabling one webhook (US-07-05, findings 3.15 and 3.16). */
describe('WooCommerceApiClient webhook state', () => {
  describe('getWebhook', () => {
    it('reads one webhook of the bound store with Basic authentication', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(200, { id: 101, status: 'active', secret: 'never-read' }),
      );
      const signal = AbortSignal.timeout(1_000);

      await expect(
        client.getWebhook(STORE, credentials, 101, signal),
      ).resolves.toEqual({ kind: 'found', status: 'active' });
      expect(requests).toEqual([
        {
          url: `${STORE}/wp-json/wc/v3/webhooks/101`,
          method: 'GET',
          authorization: BASIC,
          signal,
        },
      ]);
    });

    it.each(['active', 'paused', 'disabled'] as const)(
      'reads the documented state %s',
      async (status) => {
        const { client } = clientAnswering(() =>
          answer(200, { id: 101, status }),
        );

        await expect(
          client.getWebhook(STORE, credentials, 101),
        ).resolves.toEqual({ kind: 'found', status });
      },
    );

    it.each(['enabled', '', 7, null, undefined])(
      'keeps no state the documentation does not name (%p)',
      async (status) => {
        const { client } = clientAnswering(() =>
          answer(200, { id: 101, status }),
        );

        await expect(
          client.getWebhook(STORE, credentials, 101),
        ).resolves.toEqual({ kind: 'found', status: null });
      },
    );

    it('reads a 404 as the webhook being gone', async () => {
      const { client } = clientAnswering(() => answer(404, { code: 'x' }));

      await expect(client.getWebhook(STORE, credentials, 101)).resolves.toEqual(
        { kind: 'missing' },
      );
    });

    it.each([
      [401, 'credentials_rejected'],
      [403, 'permission_denied'],
      [429, 'unreachable'],
      [500, 'unreachable'],
      [503, 'unreachable'],
    ])('reads %i as %s', async (status, reason) => {
      const { client } = clientAnswering(() => answer(status));

      await expect(client.getWebhook(STORE, credentials, 101)).resolves.toEqual(
        { kind: 'failed', reason },
      );
    });

    it.each([
      ['another webhook’s answer', { id: 999, status: 'active' }],
      ['an answer with no id', { status: 'active' }],
      ['a list', [{ id: 101, status: 'active' }]],
      ['text', '<html>'],
    ])('trusts no state from %s', async (_label, body) => {
      const { client } = clientAnswering(() => answer(200, body));

      await expect(client.getWebhook(STORE, credentials, 101)).resolves.toEqual(
        { kind: 'failed', reason: 'unreachable' },
      );
    });

    it.each([
      ['address_not_public', 'address_not_public'],
      ['redirect', 'redirects'],
      ['tls_failed', 'tls_failed'],
      ['network', 'unreachable'],
    ] as const)(
      'maps a call the restricted client refused (%s)',
      async (code, reason) => {
        const { client } = clientAnswering(() => refusedBy(code));

        await expect(
          client.getWebhook(STORE, credentials, 101),
        ).resolves.toEqual({ kind: 'failed', reason });
      },
    );
  });

  describe('enableWebhook', () => {
    it('sets the status to active, and nothing else, on the bound store', async () => {
      const { client, requests } = clientAnswering(() =>
        answer(200, { id: 102, status: 'active' }),
      );

      await expect(
        client.enableWebhook(STORE, credentials, 102),
      ).resolves.toEqual({ kind: 'ok' });
      expect(requests).toEqual([
        {
          url: `${STORE}/wp-json/wc/v3/webhooks/102`,
          method: 'PUT',
          authorization: BASIC,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'active' }),
          signal: undefined,
        },
      ]);
    });

    it('reads a 404 as the webhook being gone', async () => {
      const { client } = clientAnswering(() => answer(404));

      await expect(
        client.enableWebhook(STORE, credentials, 102),
      ).resolves.toEqual({ kind: 'missing' });
    });

    it.each([
      [401, 'credentials_rejected'],
      [403, 'permission_denied'],
      // A host that refuses PUT (rule 8.4): not something a retry clears.
      [405, 'unreachable'],
      [501, 'unreachable'],
      [500, 'unreachable'],
    ])('reads %i as %s', async (status, reason) => {
      const { client } = clientAnswering(() => answer(status));

      await expect(
        client.enableWebhook(STORE, credentials, 102),
      ).resolves.toEqual({ kind: 'failed', reason });
    });

    it('never follows a redirect with the keys', async () => {
      const { client, requests } = clientAnswering(() => refusedBy('redirect'));

      await expect(
        client.enableWebhook(STORE, credentials, 102),
      ).resolves.toEqual({ kind: 'failed', reason: 'redirects' });
      expect(requests).toHaveLength(1);
    });
  });
});
