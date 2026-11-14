import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { encryptToken } from '../../../../shared/utils/token-encryption.util';
import type { ShopifyCredentialState } from '../../../database/repositories/shopify-offline-credentials.repository';
import { ShopifyApiService } from './shopify-api.service';
import { ShopifyCredentialService } from './shopify-credential.service';
import {
  ShopifyReauthRequiredError,
  ShopifyTokenRequestError,
} from './shopify-offline-token';

const KEY = 'a'.repeat(64);
const NOW = new Date('2026-11-14T10:00:00.000Z');
const SHOP = 'synthetic.myshopify.com';
const connection = { id: 'int-1', platformStoreUrl: SHOP };

function inMinutes(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function expiringState(
  overrides: Partial<ShopifyCredentialState> = {},
): ShopifyCredentialState {
  return {
    integrationId: 'int-1',
    shopDomain: SHOP,
    isActive: true,
    accessToken: encryptToken('stored-access', KEY),
    credentialKind: 'expiring',
    refreshToken: encryptToken('stored-refresh', KEY),
    accessTokenExpiresAt: inMinutes(30),
    refreshTokenExpiresAt: inMinutes(60 * 24 * 60),
    status: 'active',
    generation: 3,
    ...overrides,
  };
}

const NEW_PAIR = {
  accessToken: 'renewed-access',
  refreshToken: 'renewed-refresh',
  accessTokenExpiresAt: inMinutes(59),
  refreshTokenExpiresAt: inMinutes(60 * 24 * 90),
};

function setup(states: Array<ShopifyCredentialState | undefined>) {
  const queue = [...states];
  let last = queue[0];
  const repo = {
    findState: jest.fn(() => {
      if (queue.length > 0) last = queue.shift();
      return Promise.resolve(last);
    }),
    withShopLock: jest.fn((_shop: string, fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn('tx')),
    ),
    saveExpiringPair: jest.fn().mockResolvedValue(undefined),
    markReauthRequired: jest.fn().mockResolvedValue(undefined),
    recordError: jest.fn().mockResolvedValue(undefined),
  };
  const tokenClient = { refresh: jest.fn().mockResolvedValue(NEW_PAIR) };
  const config = { get: () => KEY };
  const service = new ShopifyCredentialService(
    repo as never,
    tokenClient as never,
    config as never,
  );
  return { service, repo, tokenClient };
}

describe('ShopifyCredentialService', () => {
  it('returns a fresh expiring token without taking the lock', async () => {
    const { service, repo, tokenClient } = setup([expiringState()]);
    await expect(service.getAccessToken(connection, NOW)).resolves.toEqual({
      token: 'stored-access',
      kind: 'expiring',
      generation: 3,
    });
    expect(repo.withShopLock).not.toHaveBeenCalled();
    expect(tokenClient.refresh).not.toHaveBeenCalled();
  });

  it('uses a non-expiring token as stored', async () => {
    const { service, tokenClient } = setup([
      expiringState({
        credentialKind: 'legacy',
        refreshToken: null,
        accessTokenExpiresAt: null,
      }),
    ]);
    await expect(
      service.getAccessToken(connection, NOW),
    ).resolves.toMatchObject({ token: 'stored-access', kind: 'legacy' });
    expect(tokenClient.refresh).not.toHaveBeenCalled();
  });

  it('refreshes a token about to end and stores the rotated pair', async () => {
    const ending = expiringState({ accessTokenExpiresAt: inMinutes(2) });
    const { service, repo, tokenClient } = setup([ending, ending]);
    await expect(service.getAccessToken(connection, NOW)).resolves.toEqual({
      token: 'renewed-access',
      kind: 'expiring',
      generation: 4,
    });
    expect(repo.withShopLock).toHaveBeenCalledWith(SHOP, expect.any(Function));
    expect(tokenClient.refresh).toHaveBeenCalledWith(SHOP, 'stored-refresh');
    expect(repo.saveExpiringPair).toHaveBeenCalledWith(
      'tx',
      'int-1',
      NEW_PAIR,
      'refreshed',
    );
  });

  it('skips the refresh when another worker renewed while it waited', async () => {
    const ending = expiringState({ accessTokenExpiresAt: inMinutes(2) });
    const renewed = expiringState({
      accessToken: encryptToken('other-worker-access', KEY),
      accessTokenExpiresAt: inMinutes(59),
      generation: 4,
    });
    const { service, tokenClient } = setup([ending, renewed]);
    await expect(
      service.getAccessToken(connection, NOW),
    ).resolves.toMatchObject({ token: 'other-worker-access', generation: 4 });
    expect(tokenClient.refresh).not.toHaveBeenCalled();
  });

  it('force-refreshes a rejected token only when nobody renewed it', async () => {
    const { service, tokenClient } = setup([expiringState()]);
    await service.renew(connection, 3, true, NOW);
    expect(tokenClient.refresh).toHaveBeenCalledTimes(1);

    const moved = setup([expiringState({ generation: 5 })]);
    await moved.service.renew(connection, 3, true, NOW);
    expect(moved.tokenClient.refresh).not.toHaveBeenCalled();
  });

  it('marks the store for re-authentication when Shopify refuses the refresh', async () => {
    const ending = expiringState({ accessTokenExpiresAt: inMinutes(2) });
    const { service, repo, tokenClient } = setup([ending, ending]);
    tokenClient.refresh.mockRejectedValue(
      new ShopifyTokenRequestError('rejected', 401, 'invalid_request'),
    );
    await expect(
      service.getAccessToken(connection, NOW),
    ).rejects.toBeInstanceOf(ShopifyReauthRequiredError);
    expect(repo.markReauthRequired).toHaveBeenCalledWith(
      'int-1',
      'refresh_rejected',
    );
    expect(repo.saveExpiringPair).not.toHaveBeenCalled();
  });

  it('keeps the credential when the refresh fails for a passing reason', async () => {
    const ending = expiringState({ accessTokenExpiresAt: inMinutes(2) });
    const { service, repo, tokenClient } = setup([ending, ending]);
    tokenClient.refresh.mockRejectedValue(
      new ShopifyTokenRequestError('transient', 503, undefined),
    );
    await expect(service.getAccessToken(connection, NOW)).rejects.toMatchObject(
      { kind: 'transient' },
    );
    expect(repo.markReauthRequired).not.toHaveBeenCalled();
    expect(repo.recordError).toHaveBeenCalledWith('int-1', 'refresh_transient');
  });

  it('refuses a store already waiting for the merchant', async () => {
    const { service, tokenClient } = setup([
      expiringState({ status: 'reauth_required' }),
    ]);
    await expect(
      service.getAccessToken(connection, NOW),
    ).rejects.toBeInstanceOf(ShopifyReauthRequiredError);
    expect(tokenClient.refresh).not.toHaveBeenCalled();
  });
});

describe('ShopifyApiService with expiring tokens', () => {
  const integration = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: SHOP,
    accessToken: 'unused-row-token',
    isActive: true,
    metadata: {},
  };

  function axiosError(status: number, data: unknown): AxiosError {
    return new AxiosError(String(status), undefined, undefined, undefined, {
      status,
      data,
      statusText: '',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
  }

  function setupApi(first: 'ok' | AxiosError) {
    const ok = of({
      data: { data: { shop: { name: 'Synthetic' } } },
      headers: {},
    });
    const post = jest
      .fn()
      .mockReturnValueOnce(first === 'ok' ? ok : throwError(() => first))
      .mockReturnValue(ok);
    const credentials = {
      getAccessToken: jest
        .fn()
        .mockResolvedValue({ token: 'old', kind: 'expiring', generation: 7 }),
      renew: jest
        .fn()
        .mockResolvedValue({ token: 'new', kind: 'expiring', generation: 8 }),
      markReauthRequired: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ShopifyApiService(
      { post } as never,
      { get: () => undefined } as never,
      credentials as never,
    );
    return { service, post, credentials };
  }

  function sentToken(post: jest.Mock, call: number): unknown {
    const calls = post.mock.calls as unknown[][];
    return (calls[call][2] as { headers: Record<string, string> }).headers[
      'X-Shopify-Access-Token'
    ];
  }

  it('sends the token the credential service hands out', async () => {
    const { service, post } = setupApi('ok');
    await expect(service.getShopName(integration)).resolves.toBe('Synthetic');
    expect(sentToken(post, 0)).toBe('old');
  });

  it('renews once after a 401 and retries with the new token', async () => {
    const { service, post, credentials } = setupApi(axiosError(401, {}));
    await expect(service.getShopName(integration)).resolves.toBe('Synthetic');
    expect(credentials.renew).toHaveBeenCalledWith(integration, 7, true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(sentToken(post, 1)).toBe('new');
  });

  it('marks a store whose non-expiring token Shopify no longer accepts', async () => {
    const { service, credentials } = setupApi(
      axiosError(403, {
        errors:
          'Non-expiring access tokens are no longer accepted for the Admin API',
      }),
    );
    await expect(service.getShopName(integration)).rejects.toBeInstanceOf(
      ShopifyReauthRequiredError,
    );
    expect(credentials.markReauthRequired).toHaveBeenCalledWith(
      integration,
      'legacy_token_rejected',
    );
  });

  it('leaves other failures to the caller', async () => {
    const { service, credentials, post } = setupApi(
      axiosError(403, { errors: 'Missing access scope' }),
    );
    await expect(service.getShopName(integration)).rejects.toBeInstanceOf(
      AxiosError,
    );
    expect(credentials.renew).not.toHaveBeenCalled();
    expect(credentials.markReauthRequired).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
