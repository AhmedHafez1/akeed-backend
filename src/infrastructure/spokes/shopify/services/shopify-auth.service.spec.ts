import type { ShopifyCredentialState } from '../../../database/repositories/shopify-offline-credentials.repository';
import { ShopifyAuthService } from './shopify-auth.service';
import { ShopifyTokenRequestError } from './shopify-offline-token';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const SHOP = 'synthetic.myshopify.com';
const PAIR = {
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  accessTokenExpiresAt: '2026-11-14T10:59:00.000Z',
  refreshTokenExpiresAt: '2027-02-12T10:00:00.000Z',
};
const DAY = 24 * 60 * 60_000;

function state(
  overrides: Partial<ShopifyCredentialState> = {},
): ShopifyCredentialState {
  return {
    integrationId: 'int-1',
    shopDomain: SHOP,
    isActive: true,
    accessToken: 'enc',
    credentialKind: 'expiring',
    refreshToken: 'enc-refresh',
    accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 60 * DAY).toISOString(),
    status: 'active',
    generation: 1,
    ...overrides,
  };
}

function setup(options: {
  installed: boolean;
  credential?: ShopifyCredentialState;
  env?: Record<string, string>;
}) {
  const env: Record<string, string> = {
    SHOPIFY_API_KEY: 'synthetic-key',
    SHOPIFY_API_SECRET: 'synthetic-secret',
    API_URL: 'https://api.example.test',
    ...options.env,
  };
  const config = {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => env[key],
  };
  const integration = { id: 'int-1', orgId: 'org-1', isActive: true };
  const integrationsRepo = {
    findByPlatformDomain: jest
      .fn()
      .mockResolvedValue(options.installed ? integration : undefined),
    upsertShopifyIntegration: jest.fn().mockResolvedValue(integration),
  };
  const organizationsRepo = {
    createOrUpdateBySlug: jest.fn().mockResolvedValue({ id: 'org-1' }),
  };
  const membershipsRepo = {
    findByOrg: jest.fn().mockResolvedValue([{ userId: 'user-1' }]),
  };
  const tokenClient = {
    exchangeIdToken: jest.fn().mockResolvedValue(PAIR),
    exchangeCode: jest.fn().mockResolvedValue(PAIR),
  };
  const credentialsRepo = {
    findStateByShop: jest.fn().mockResolvedValue(options.credential),
    withShopLock: jest.fn((_shop: string, fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn('tx')),
    ),
    upsertExpiringCredential: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ShopifyAuthService(
    config as never,
    {} as never,
    integrationsRepo as never,
    organizationsRepo as never,
    membershipsRepo as never,
    tokenClient as never,
    credentialsRepo as never,
  );
  const internals = service as any;
  jest
    .spyOn(internals, 'decodeAndVerifySessionToken')
    .mockReturnValue({ dest: `https://${SHOP}` });
  const registerWebhooks = jest
    .spyOn(internals, 'registerWebhooks')
    .mockResolvedValue(undefined);
  jest.spyOn(internals, 'syncShopProfile').mockResolvedValue(undefined);
  const recordInstallation = jest
    .spyOn(internals, 'recordInstallation')
    .mockResolvedValue(undefined);
  return {
    service,
    integrationsRepo,
    tokenClient,
    credentialsRepo,
    registerWebhooks,
    recordInstallation,
  };
}

describe('ShopifyAuthService expiring offline tokens', () => {
  it('stores a new install’s pair with the integration under the shop lock', async () => {
    const t = setup({ installed: false });
    await t.service.tokenExchange('session-token');

    expect(t.tokenClient.exchangeIdToken).toHaveBeenCalledWith(
      SHOP,
      'session-token',
    );
    expect(t.credentialsRepo.withShopLock).toHaveBeenCalledWith(
      SHOP,
      expect.any(Function),
    );
    expect(t.integrationsRepo.upsertShopifyIntegration).toHaveBeenCalledWith(
      'org-1',
      SHOP,
      'shopify',
      'new-access',
      PAIR.accessTokenExpiresAt,
      'tx',
    );
    expect(t.credentialsRepo.upsertExpiringCredential).toHaveBeenCalledWith(
      'tx',
      'int-1',
      PAIR,
      'acquired',
    );
    expect(t.registerWebhooks).toHaveBeenCalledWith(SHOP, 'new-access');
    expect(t.recordInstallation).toHaveBeenCalled();
  });

  it('leaves a healthy installed store alone', async () => {
    const t = setup({ installed: true, credential: state() });
    await t.service.tokenExchange('session-token');
    expect(t.tokenClient.exchangeIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ['waits for the merchant', state({ status: 'reauth_required' })],
    [
      'has a refresh token ending within a week',
      state({
        refreshTokenExpiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      }),
    ],
  ])(
    're-acquires a pair for an installed store that %s',
    async (_, credential) => {
      const t = setup({ installed: true, credential });
      await t.service.tokenExchange('session-token');
      expect(t.tokenClient.exchangeIdToken).toHaveBeenCalledTimes(1);
      expect(t.credentialsRepo.upsertExpiringCredential).toHaveBeenCalled();
      // Not a new install: no webhooks or lifecycle start.
      expect(t.registerWebhooks).not.toHaveBeenCalled();
      expect(t.recordInstallation).not.toHaveBeenCalled();
    },
  );

  it('moves a non-expiring store on open only when the migration allows it', async () => {
    const legacy = state({ credentialKind: 'legacy', refreshToken: null });
    const off = setup({ installed: true, credential: legacy });
    await off.service.tokenExchange('session-token');
    expect(off.tokenClient.exchangeIdToken).not.toHaveBeenCalled();

    const on = setup({
      installed: true,
      credential: legacy,
      env: { SHOPIFY_TOKEN_MIGRATION_ENABLED: 'true' },
    });
    await on.service.tokenExchange('session-token');
    expect(on.tokenClient.exchangeIdToken).toHaveBeenCalledTimes(1);

    const outsideCanary = setup({
      installed: true,
      credential: legacy,
      env: {
        SHOPIFY_TOKEN_MIGRATION_ENABLED: 'true',
        SHOPIFY_TOKEN_MIGRATION_SHOPS: 'other.myshopify.com',
      },
    });
    await outsideCanary.service.tokenExchange('session-token');
    expect(outsideCanary.tokenClient.exchangeIdToken).not.toHaveBeenCalled();
  });

  it('still opens an installed store when renewing its pair fails', async () => {
    const t = setup({
      installed: true,
      credential: state({ status: 'reauth_required' }),
    });
    t.tokenClient.exchangeIdToken.mockRejectedValue(
      new ShopifyTokenRequestError('transient', 503, undefined),
    );
    await expect(t.service.tokenExchange('session-token')).resolves.toEqual({
      installed: true,
      shop: SHOP,
    });
    expect(t.credentialsRepo.upsertExpiringCredential).not.toHaveBeenCalled();
  });

  it('answers with the existing code when Shopify refuses the exchange', async () => {
    const t = setup({ installed: false });
    t.tokenClient.exchangeIdToken.mockRejectedValue(
      new ShopifyTokenRequestError('failed', 400, 'invalid_client'),
    );
    await expect(
      t.service.tokenExchange('session-token'),
    ).rejects.toMatchObject({
      response: { code: 'SHOPIFY_TOKEN_EXCHANGE_FAILED' },
    });
    expect(t.integrationsRepo.upsertShopifyIntegration).not.toHaveBeenCalled();
  });
});
