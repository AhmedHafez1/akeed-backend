import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/infrastructure/database';
import { ShopifyOfflineCredentialsRepository } from '../src/infrastructure/database/repositories/shopify-offline-credentials.repository';
import { ShopifyCredentialService } from '../src/infrastructure/spokes/shopify/services/shopify-credential.service';
import { encryptToken } from '../src/shared/utils/token-encryption.util';

function testDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NOT RUN: invalid test database URL (value withheld).');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/akeed_e01_test' ||
    url.username !== 'e01_test' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'NOT RUN: use local PostgreSQL, user e01_test, database akeed_e01_test, without query parameters.',
    );
  }
  return value;
}

const KEY = 'a'.repeat(64);
const databaseUrl = testDatabaseUrl();
const namespace = `shopify_cred_${randomUUID().replaceAll('-', '')}`;
const client = postgres(databaseUrl, {
  max: 6,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
const config = {
  get: () => KEY,
  getOrThrow: () => KEY,
};
const repository = new ShopifyOfflineCredentialsRepository(
  db as never,
  config as never,
);
let createdSchema = false;

const migration = readFileSync(
  resolve(__dirname, '../drizzle/0101_shopify_offline_credentials.sql'),
  'utf8',
);

async function applyMigration(): Promise<void> {
  await client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO "${namespace}"`);
    for (const statement of migration.split('--> statement-breakpoint'))
      if (statement.trim()) await tx.unsafe(statement);
  });
}

async function insertStore(
  shop: string,
  overrides: { isActive?: boolean; uninstalledAt?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await client.unsafe(
    `INSERT INTO "${namespace}".integrations (id, org_id, platform_type, platform_store_url, access_token, is_active, uninstalled_at)
     VALUES ($1, $2, 'shopify', $3, $4, $5, $6)`,
    [
      id,
      randomUUID(),
      shop,
      encryptToken(`token-${shop}`, KEY),
      overrides.isActive ?? true,
      overrides.uninstalledAt ?? null,
    ],
  );
  return id;
}

const PAIR = {
  accessToken: 'stored-access',
  refreshToken: 'stored-refresh',
  accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
};

describe('Shopify offline credentials PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    createdSchema = true;
    await client.unsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
       END $$`,
    );
    // Only the integration columns the repository reads or writes.
    await client.unsafe(
      `CREATE TABLE "${namespace}".integrations (
         id uuid PRIMARY KEY,
         org_id uuid NOT NULL,
         platform_type text NOT NULL,
         platform_store_url text NOT NULL,
         access_token text,
         expires_at timestamptz,
         is_active boolean DEFAULT true,
         uninstalled_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await applyMigration();
    await applyMigration();
  });

  afterAll(async () => {
    try {
      if (createdSchema) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await client.unsafe(`DELETE FROM "${namespace}".integrations`);
  });

  it('refuses an expiring credential without its refresh token', async () => {
    const id = await insertStore('check.myshopify.com');
    await expect(
      client.unsafe(
        `INSERT INTO "${namespace}".shopify_offline_credentials (integration_id, credential_kind) VALUES ($1, 'expiring')`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('stores an encrypted pair and bumps the generation on each write', async () => {
    const id = await insertStore('store.myshopify.com');
    await repository.withShopLock('store.myshopify.com', (tx) =>
      repository.saveExpiringPair(tx, id, PAIR, 'migrated'),
    );
    await repository.withShopLock('store.myshopify.com', (tx) =>
      repository.saveExpiringPair(tx, id, PAIR, 'refreshed'),
    );
    const state = await repository.findState(id);
    expect(state).toMatchObject({
      credentialKind: 'expiring',
      status: 'active',
      generation: 1,
    });
    expect(state?.refreshToken).not.toBe('stored-refresh');
    expect(state?.refreshToken).toMatch(/^v1:/);
    const [row] = await client.unsafe<
      { migrated_at: Date | null; last_refreshed_at: Date | null }[]
    >(
      `SELECT migrated_at, last_refreshed_at FROM "${namespace}".shopify_offline_credentials WHERE integration_id = $1`,
      [id],
    );
    expect(row.migrated_at).not.toBeNull();
    expect(row.last_refreshed_at).not.toBeNull();
  });

  it('lets only one of two concurrent workers refresh a shop', async () => {
    const id = await insertStore('race.myshopify.com');
    await repository.withShopLock('race.myshopify.com', (tx) =>
      repository.saveExpiringPair(tx, id, PAIR, 'acquired'),
    );
    const refresh = jest.fn(
      () =>
        new Promise((done) =>
          setTimeout(
            () =>
              done({
                accessToken: 'renewed-access',
                refreshToken: 'renewed-refresh',
                accessTokenExpiresAt: new Date(
                  Date.now() + 59 * 60_000,
                ).toISOString(),
                refreshTokenExpiresAt: PAIR.refreshTokenExpiresAt,
              }),
            200,
          ),
        ),
    );
    const service = new ShopifyCredentialService(
      repository,
      { refresh } as never,
      config as never,
    );
    const connection = { id, platformStoreUrl: 'race.myshopify.com' };

    const tokens = await Promise.all([
      service.getAccessToken(connection),
      service.getAccessToken(connection),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokens.map((token) => token.token)).toEqual([
      'renewed-access',
      'renewed-access',
    ]);
  });

  it('deletes the credential with its store', async () => {
    const id = await insertStore('gone.myshopify.com');
    await repository.withShopLock('gone.myshopify.com', (tx) =>
      repository.saveExpiringPair(tx, id, PAIR, 'acquired'),
    );
    await client.unsafe(
      `DELETE FROM "${namespace}".integrations WHERE id = $1`,
      [id],
    );
    const rows = await client.unsafe(
      `SELECT 1 FROM "${namespace}".shopify_offline_credentials WHERE integration_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });

  it('picks only installed stores still on a non-expiring token', async () => {
    const fresh = await insertStore('fresh.myshopify.com');
    const failedBefore = await insertStore('failed.myshopify.com');
    await repository.recordError(failedBefore, 'migrate_transient');
    const moved = await insertStore('moved.myshopify.com');
    await repository.withShopLock('moved.myshopify.com', (tx) =>
      repository.saveExpiringPair(tx, moved, PAIR, 'migrated'),
    );
    const dead = await insertStore('dead.myshopify.com');
    await repository.markReauthRequired(dead, 'migrate_invalid_subject_token');
    await insertStore('off.myshopify.com', { isActive: false });
    await insertStore('leaving.myshopify.com', {
      uninstalledAt: new Date().toISOString(),
    });

    const batch = await repository.findLegacyBatch(10);
    expect(batch.map((store) => store.integrationId)).toEqual([
      fresh,
      failedBefore,
    ]);
    const canary = await repository.findLegacyBatch(10, [
      'failed.myshopify.com',
    ]);
    expect(canary.map((store) => store.integrationId)).toEqual([failedBefore]);
  });

  it('finds expiring credentials whose refresh token ends soon', async () => {
    const soon = await insertStore('soon.myshopify.com');
    await repository.withShopLock('soon.myshopify.com', (tx) =>
      repository.saveExpiringPair(
        tx,
        soon,
        {
          ...PAIR,
          refreshTokenExpiresAt: new Date(
            Date.now() + 3 * 86_400_000,
          ).toISOString(),
        },
        'acquired',
      ),
    );
    const later = await insertStore('later.myshopify.com');
    await repository.withShopLock('later.myshopify.com', (tx) =>
      repository.saveExpiringPair(tx, later, PAIR, 'acquired'),
    );
    const due = await repository.findRefreshDue(
      new Date(Date.now() + 14 * 86_400_000).toISOString(),
      10,
    );
    expect(due.map((row) => row.integrationId)).toEqual([soon]);
  });
});
