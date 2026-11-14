import { encryptToken } from '../../../../shared/utils/token-encryption.util';
import type { ShopifyCredentialState } from '../../../database/repositories/shopify-offline-credentials.repository';
import {
  ShopifyReauthRequiredError,
  ShopifyTokenRequestError,
} from '../services/shopify-offline-token';
import {
  isShopInMigrationScope,
  parseMigrationBatchSize,
  parseMigrationShops,
} from './shopify-offline-credentials.constants';
import { ShopifyOfflineCredentialsService } from './shopify-offline-credentials.service';

const KEY = 'a'.repeat(64);
const NOW = new Date('2026-11-14T10:00:00.000Z');
const PAIR = {
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  accessTokenExpiresAt: '2026-11-14T10:59:00.000Z',
  refreshTokenExpiresAt: '2027-02-12T10:00:00.000Z',
};

function legacyState(
  overrides: Partial<ShopifyCredentialState> = {},
): ShopifyCredentialState {
  return {
    integrationId: 'int-1',
    shopDomain: 'one.myshopify.com',
    isActive: true,
    accessToken: encryptToken('legacy-token', KEY),
    credentialKind: 'legacy',
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    status: 'active',
    generation: 0,
    ...overrides,
  };
}

function setup(
  env: Record<string, string | undefined>,
  state: ShopifyCredentialState = legacyState(),
) {
  const repo = {
    findLegacyBatch: jest
      .fn()
      .mockResolvedValue([
        { integrationId: 'int-1', shopDomain: 'one.myshopify.com' },
      ]),
    findRefreshDue: jest.fn().mockResolvedValue([]),
    findState: jest.fn().mockResolvedValue(state),
    withShopLock: jest.fn((_shop: string, fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn('tx')),
    ),
    saveExpiringPair: jest.fn().mockResolvedValue(undefined),
    markReauthRequired: jest.fn().mockResolvedValue(undefined),
    recordError: jest.fn().mockResolvedValue(undefined),
  };
  const tokenClient = { migrateLegacy: jest.fn().mockResolvedValue(PAIR) };
  const credentialService = { renew: jest.fn().mockResolvedValue({}) };
  const config = {
    get: (key: string) => env[key],
    getOrThrow: () => KEY,
  };
  const service = new ShopifyOfflineCredentialsService(
    repo as never,
    tokenClient as never,
    credentialService as never,
    config as never,
  );
  return { service, repo, tokenClient, credentialService };
}

const MIGRATION_ON = { SHOPIFY_TOKEN_MIGRATION_ENABLED: 'true' };

describe('ShopifyOfflineCredentialsService', () => {
  it('moves nothing while the migration switch is off', async () => {
    const { service, repo, tokenClient } = setup({});
    await service.runOnce(NOW);
    expect(repo.findLegacyBatch).not.toHaveBeenCalled();
    expect(tokenClient.migrateLegacy).not.toHaveBeenCalled();
  });

  it('moves a legacy store under its lock and stores the pair', async () => {
    const { service, repo, tokenClient } = setup(MIGRATION_ON);
    const summary = await service.runOnce(NOW);
    expect(repo.withShopLock).toHaveBeenCalledWith(
      'one.myshopify.com',
      expect.any(Function),
    );
    expect(tokenClient.migrateLegacy).toHaveBeenCalledWith(
      'one.myshopify.com',
      'legacy-token',
    );
    expect(repo.saveExpiringPair).toHaveBeenCalledWith(
      'tx',
      'int-1',
      PAIR,
      'migrated',
    );
    expect(summary).toMatchObject({ migrated: 1, migrationFailed: 0 });
  });

  it('passes the batch size and canary list to the query', async () => {
    const { service, repo } = setup({
      ...MIGRATION_ON,
      SHOPIFY_TOKEN_MIGRATION_BATCH_SIZE: '3',
      SHOPIFY_TOKEN_MIGRATION_SHOPS: ' One.myshopify.com ,two.myshopify.com',
    });
    await service.runOnce(NOW);
    expect(repo.findLegacyBatch).toHaveBeenCalledWith(3, [
      'one.myshopify.com',
      'two.myshopify.com',
    ]);
  });

  it('skips a store that moved or uninstalled since it was picked', async () => {
    const { service, tokenClient } = setup(
      MIGRATION_ON,
      legacyState({ credentialKind: 'expiring' }),
    );
    const summary = await service.runOnce(NOW);
    expect(tokenClient.migrateLegacy).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ migrated: 0, skipped: 1 });
  });

  it('marks a store whose token Shopify will not exchange', async () => {
    const { service, repo, tokenClient } = setup(MIGRATION_ON);
    tokenClient.migrateLegacy.mockRejectedValue(
      new ShopifyTokenRequestError(
        'invalid_subject_token',
        400,
        'invalid_subject_token',
      ),
    );
    const summary = await service.runOnce(NOW);
    expect(repo.markReauthRequired).toHaveBeenCalledWith(
      'int-1',
      'migrate_invalid_subject_token',
    );
    expect(repo.saveExpiringPair).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ reauthRequired: 1, migrated: 0 });
  });

  it('keeps the legacy token for the next run after a network failure', async () => {
    const { service, repo, tokenClient } = setup(MIGRATION_ON);
    tokenClient.migrateLegacy.mockRejectedValue(
      new ShopifyTokenRequestError('transient', undefined, undefined),
    );
    const summary = await service.runOnce(NOW);
    expect(repo.recordError).toHaveBeenCalledWith('int-1', 'migrate_transient');
    expect(repo.markReauthRequired).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ migrationFailed: 1 });
  });

  it('renews refresh tokens that end within two weeks', async () => {
    const { service, repo, credentialService } = setup({});
    repo.findRefreshDue.mockResolvedValue([
      {
        integrationId: 'int-2',
        shopDomain: 'two.myshopify.com',
        generation: 4,
      },
      {
        integrationId: 'int-3',
        shopDomain: 'three.myshopify.com',
        generation: 1,
      },
    ]);
    credentialService.renew
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new ShopifyReauthRequiredError(
          'three.myshopify.com',
          'refresh_rejected',
        ),
      );
    const summary = await service.runOnce(NOW);
    expect(repo.findRefreshDue).toHaveBeenCalledWith(
      '2026-11-28T10:00:00.000Z',
      100,
    );
    expect(credentialService.renew).toHaveBeenCalledWith(
      { id: 'int-2', platformStoreUrl: 'two.myshopify.com' },
      4,
      true,
    );
    expect(summary).toMatchObject({ refreshed: 1, reauthRequired: 1 });
  });

  it('stops the keep-alive when switched off', async () => {
    const { service, repo } = setup({
      SHOPIFY_TOKEN_REFRESH_JOB_ENABLED: 'false',
    });
    await service.runOnce(NOW);
    expect(repo.findRefreshDue).not.toHaveBeenCalled();
  });
});

describe('migration settings', () => {
  it('reads the batch size within bounds', () => {
    expect(parseMigrationBatchSize(undefined)).toBe(10);
    expect(parseMigrationBatchSize('abc')).toBe(10);
    expect(parseMigrationBatchSize('0')).toBe(10);
    expect(parseMigrationBatchSize('25')).toBe(25);
    expect(parseMigrationBatchSize('5000')).toBe(100);
  });

  it('reads the canary list', () => {
    expect(parseMigrationShops(undefined)).toEqual([]);
    expect(parseMigrationShops(' A.myshopify.com, ,b.myshopify.com')).toEqual([
      'a.myshopify.com',
      'b.myshopify.com',
    ]);
  });

  it('lets a store move only when switched on and listed', () => {
    expect(isShopInMigrationScope('a.myshopify.com', undefined, '')).toBe(
      false,
    );
    expect(isShopInMigrationScope('a.myshopify.com', 'true', '')).toBe(true);
    expect(
      isShopInMigrationScope('a.myshopify.com', 'true', 'b.myshopify.com'),
    ).toBe(false);
  });
});
