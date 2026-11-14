import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import {
  classifyTokenFailure,
  isLegacyTokenRejection,
  parseExpiringTokenResponse,
  ShopifyTokenRequestError,
  ShopifyTokenResponseInvalidError,
} from './shopify-offline-token';
import { ShopifyTokenClient } from './shopify-token.client';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const VALID = {
  access_token: 'synthetic-access',
  expires_in: 3600,
  refresh_token: 'synthetic-refresh',
  refresh_token_expires_in: 7776000,
  scope: 'read_orders,write_orders',
};

describe('parseExpiringTokenResponse', () => {
  it('reads the pair and pulls the access expiry a minute early', () => {
    expect(parseExpiringTokenResponse(VALID, NOW)).toEqual({
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      accessTokenExpiresAt: '2026-11-14T10:59:00.000Z',
      refreshTokenExpiresAt: '2027-02-12T10:00:00.000Z',
      scope: 'read_orders,write_orders',
    });
  });

  it.each([
    ['access_token', { ...VALID, access_token: '' }],
    ['refresh_token', { ...VALID, refresh_token: undefined }],
    ['expires_in', { ...VALID, expires_in: 0 }],
    ['expires_in', { ...VALID, expires_in: 1.5 }],
    ['refresh_token_expires_in', { ...VALID, refresh_token_expires_in: null }],
  ])('rejects an answer without a valid %s', (field, body) => {
    expect(() => parseExpiringTokenResponse(body, NOW)).toThrow(
      new ShopifyTokenResponseInvalidError(field),
    );
  });

  it('rejects a non-expiring answer and never puts a token in the message', () => {
    let message = '';
    try {
      parseExpiringTokenResponse({ access_token: 'secret-legacy', scope: 'x' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('refresh_token');
    expect(message).not.toContain('secret-legacy');
  });
});

describe('classifyTokenFailure', () => {
  it.each([
    [undefined, undefined, 'transient'],
    [429, undefined, 'transient'],
    [503, { error: 'x' }, 'transient'],
    [401, { error: 'invalid_request' }, 'rejected'],
    [400, { error: 'invalid_request' }, 'rejected'],
    [400, { error: 'invalid_grant' }, 'rejected'],
    [400, { error: 'invalid_subject_token' }, 'invalid_subject_token'],
    [400, { error: 'invalid_requested_token_type' }, 'failed'],
    [403, { errors: 'Forbidden' }, 'failed'],
  ])('status %s with %j is %s', (status, data, kind) => {
    expect(classifyTokenFailure(status, data).kind).toBe(kind);
  });
});

describe('isLegacyTokenRejection', () => {
  it('matches only Shopify’s non-expiring 403', () => {
    expect(
      isLegacyTokenRejection(403, {
        errors:
          '[API] Non-expiring access tokens are no longer accepted for the Admin API.',
      }),
    ).toBe(true);
    expect(isLegacyTokenRejection(403, { errors: 'Missing scope' })).toBe(
      false,
    );
    expect(
      isLegacyTokenRejection(401, {
        errors: 'Non-expiring access tokens are no longer accepted',
      }),
    ).toBe(false);
  });
});

describe('ShopifyTokenClient', () => {
  const config = {
    getOrThrow: (key: string) =>
      key === 'SHOPIFY_API_KEY' ? 'synthetic-key' : 'synthetic-secret',
  };

  function setup(result: 'ok' | AxiosError = 'ok') {
    const post = jest
      .fn()
      .mockReturnValue(
        result === 'ok'
          ? of({ data: VALID, headers: {} })
          : throwError(() => result),
      );
    return {
      post,
      client: new ShopifyTokenClient({ post } as never, config as never),
    };
  }

  function sentCall(post: jest.Mock): unknown[] {
    return (post.mock.calls as unknown[][])[0];
  }

  function sentBody(post: jest.Mock): Record<string, unknown> {
    return sentCall(post)[1] as Record<string, unknown>;
  }

  it('asks for an expiring pair on the ID-token exchange', async () => {
    const { client, post } = setup();
    await client.exchangeIdToken('synthetic.myshopify.com', 'id-token');
    expect(sentCall(post)[0]).toBe(
      'https://synthetic.myshopify.com/admin/oauth/access_token',
    );
    expect(sentBody(post)).toEqual({
      client_id: 'synthetic-key',
      client_secret: 'synthetic-secret',
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'id-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type:
        'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
  });

  it('asks for an expiring pair on the authorization code grant', async () => {
    const { client, post } = setup();
    await client.exchangeCode('synthetic.myshopify.com', 'code-1');
    expect(sentBody(post)).toEqual({
      client_id: 'synthetic-key',
      client_secret: 'synthetic-secret',
      code: 'code-1',
      expiring: '1',
    });
  });

  it('refreshes with the refresh-token grant', async () => {
    const { client, post } = setup();
    await client.refresh('synthetic.myshopify.com', 'refresh-1');
    expect(sentBody(post)).toEqual({
      client_id: 'synthetic-key',
      client_secret: 'synthetic-secret',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
  });

  it('moves a non-expiring token with the offline-token exchange', async () => {
    const { client, post } = setup();
    await client.migrateLegacy('synthetic.myshopify.com', 'legacy-1');
    expect(sentBody(post)).toEqual({
      client_id: 'synthetic-key',
      client_secret: 'synthetic-secret',
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'legacy-1',
      subject_token_type:
        'urn:shopify:params:oauth:token-type:offline-access-token',
      requested_token_type:
        'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
  });

  it('classifies a refused refresh as rejected', async () => {
    const error = new AxiosError('401', undefined, undefined, undefined, {
      status: 401,
      data: { error: 'invalid_request' },
      statusText: 'Unauthorized',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    const { client } = setup(error);
    await expect(
      client.refresh('synthetic.myshopify.com', 'refresh-1'),
    ).rejects.toEqual(
      new ShopifyTokenRequestError('rejected', 401, 'invalid_request'),
    );
  });

  it('classifies a network failure as transient', async () => {
    const { client } = setup(new AxiosError('socket hang up'));
    await expect(
      client.refresh('synthetic.myshopify.com', 'refresh-1'),
    ).rejects.toMatchObject({ kind: 'transient' });
  });
});
