import {
  HttpException,
  Logger,
  type ExecutionContext,
  type LoggerService,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { IntegrationApiKeysRepository } from '../src/infrastructure/database/repositories/integration-api-keys.repository';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../src/modules/auth/organization-role';
import { IntegrationApiKeyGuard } from '../src/modules/integration-keys/guards/integration-api-key.guard';
import { hashIntegrationApiKeySecret } from '../src/modules/integration-keys/integration-api-key.secret';
import type { RequestWithIntegrationApiKey } from '../src/modules/integration-keys/integration-api-key.principal';
import {
  IntegrationKeysService,
  MAX_ACTIVE_INTEGRATION_API_KEYS,
} from '../src/modules/integration-keys/integration-keys.service';
import type { StandaloneOrderIngestionService } from '../src/modules/order-ingestion/standalone-order-ingestion.service';
import type { StandaloneSourceCodeMap } from '../src/modules/order-ingestion/standalone-source-resolver';

function isolatedDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value) {
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  }
  const url = new URL(value);
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

const namespace = `e05_integration_keys_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 12,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const repository = new IntegrationApiKeysRepository(database);
let created = false;

interface Tenant {
  orgId: string;
  integrationId: string;
}

/** The organization's resolved Standalone source, keyed by organization. */
const sources = new Map<string, string>();

/**
 * The session path's resolver, reduced to what this story relies on: the
 * real role rule with the API key codes, and the seeded source of the
 * caller's own organization. The resolver's source checks are unit-tested.
 */
const ingestion = {
  assertWritableRole(user: AuthenticatedUser, codes: StandaloneSourceCodeMap) {
    assertOrganizationWriteAllowed(user.role, codes.roleRequired);
  },
  resolveWritableSource(
    user: AuthenticatedUser,
    codes: StandaloneSourceCodeMap,
  ) {
    assertOrganizationWriteAllowed(user.role, codes.roleRequired);
    return Promise.resolve({ id: sources.get(user.orgId), orgId: user.orgId });
  },
} as unknown as StandaloneOrderIngestionService;

const service = new IntegrationKeysService(repository, ingestion);
const guard = new IntegrationApiKeyGuard(repository);

async function createTenant(): Promise<Tenant> {
  const [organization] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES ('Org', ${`org-${randomUUID()}`})
    RETURNING id`;
  const [integration] = await client<{ id: string }[]>`
    INSERT INTO integrations (org_id, platform_type, platform_store_url)
    VALUES (${organization.id}, 'standalone', ${`standalone:${organization.id}`})
    RETURNING id`;
  sources.set(organization.id, integration.id);
  return { orgId: organization.id, integrationId: integration.id };
}

function member(
  tenant: Tenant,
  role: AuthenticatedUser['role'],
): AuthenticatedUser {
  return {
    userId: randomUUID(),
    orgId: tenant.orgId,
    role,
    source: 'supabase',
  };
}

function contextFor(
  authorization: string | undefined,
  query: Record<string, unknown> = {},
): { context: ExecutionContext; request: RequestWithIntegrationApiKey } {
  const request = {
    headers: authorization ? { authorization } : {},
    query,
  } as unknown as RequestWithIntegrationApiKey;
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

/** The HTTP status the guard answers with, or 200 and the principal. */
async function authenticate(
  authorization: string | undefined,
  query: Record<string, unknown> = {},
): Promise<{ status: number; request: RequestWithIntegrationApiKey }> {
  const { context, request } = contextFor(authorization, query);
  try {
    await guard.canActivate(context);
    return { status: 200, request };
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), request };
    throw error;
  }
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

async function keyRow(id: string) {
  const [row] = await client<
    {
      key_hash: string;
      last_used_at: string | Date | null;
      revoked_at: string | Date | null;
      revoked_by: string | null;
    }[]
  >`SELECT key_hash, last_used_at, revoked_at, revoked_by FROM integration_api_keys WHERE id = ${id}`;
  return row;
}

describe('integration API keys PostgreSQL contract (US-05-01)', () => {
  const logs: string[] = [];

  beforeAll(async () => {
    const capture: LoggerService = {
      log: (message: unknown) => logs.push(String(message)),
      warn: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => logs.push(String(message)),
    };
    Logger.overrideLogger(capture);

    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE FUNCTION get_user_org_id() RETURNS uuid LANGUAGE sql STABLE
        AS $fn$ SELECT nullif(current_setting('akeed.test_org', true), '')::uuid $fn$;
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE
      );
      CREATE TABLE integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        UNIQUE (platform_type, platform_store_url),
        UNIQUE (id, org_id)
      );
    `);
    // Applied twice: the migration must be re-runnable.
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of readFileSync(
        resolve(__dirname, '../drizzle/0046_integration_api_keys.sql'),
        'utf8',
      ).split('--> statement-breakpoint')) {
        if (statement.trim()) await client.unsafe(statement);
      }
    }
    await client.unsafe(
      `GRANT USAGE ON SCHEMA ${namespace} TO authenticated, anon;`,
    );
  });

  afterAll(async () => {
    Logger.overrideLogger(['log', 'warn', 'error']);
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  describe('owner / admin / viewer matrix', () => {
    it.each(['owner', 'admin'] as const)(
      'an %s creates a key that authenticates as their own integration',
      async (role) => {
        const tenant = await createTenant();

        const issued = await service.create(member(tenant, role), {
          name: 'Shop server',
        });
        const result = await authenticate(`Bearer ${issued.secret}`);

        expect(result.status).toBe(200);
        expect(result.request.integrationApiKey).toEqual({
          orgId: tenant.orgId,
          integrationId: tenant.integrationId,
          keyId: issued.key.id,
          prefix: issued.key.prefix,
        });
      },
    );

    it('a viewer lists keys but cannot create or revoke', async () => {
      const tenant = await createTenant();
      const issued = await service.create(member(tenant, 'owner'), {
        name: 'Shop server',
      });
      const viewer = member(tenant, 'viewer');

      await expect(
        statusOf(service.create(viewer, { name: 'x' })),
      ).resolves.toBe(403);
      await expect(
        statusOf(service.revoke(viewer, issued.key.id)),
      ).resolves.toBe(403);
      const listed = await service.list(viewer);
      expect(listed.keys.map((key) => [key.id, key.status])).toEqual([
        [issued.key.id, 'active'],
      ]);
      expect((await keyRow(issued.key.id)).revoked_at).toBeNull();
    });

    it('keeps tenants apart: lists, revocation and principals never cross organizations', async () => {
      const a = await createTenant();
      const b = await createTenant();
      const keyA = await service.create(member(a, 'owner'), { name: 'A' });
      const keyB = await service.create(member(b, 'owner'), { name: 'B' });

      expect(
        (await service.list(member(b, 'owner'))).keys.map((key) => key.id),
      ).toEqual([keyB.key.id]);
      await expect(
        statusOf(service.revoke(member(b, 'owner'), keyA.key.id)),
      ).resolves.toBe(404);
      expect((await keyRow(keyA.key.id)).revoked_at).toBeNull();

      const asA = await authenticate(`Bearer ${keyA.secret}`);
      const asB = await authenticate(`Bearer ${keyB.secret}`);
      expect(asA.request.integrationApiKey?.orgId).toBe(a.orgId);
      expect(asB.request.integrationApiKey?.orgId).toBe(b.orgId);
      // A's prefix with B's secret is not A's key.
      const spliced = `${keyA.key.prefix}_${keyB.secret.slice(17)}`;
      await expect(authenticate(`Bearer ${spliced}`)).resolves.toMatchObject({
        status: 401,
      });
    });
  });

  it('stores only the hash, and the secret appears only in the create response', async () => {
    const tenant = await createTenant();
    logs.length = 0;

    const issued = await service.create(member(tenant, 'admin'), {
      name: 'Shop server',
    });

    const encodedSecret = issued.secret.slice(17);
    const row = await keyRow(issued.key.id);
    expect(row.key_hash).toBe(
      hashIntegrationApiKeySecret(Buffer.from(encodedSecret, 'base64url')),
    );
    const [stored] = await client<{ dump: string }[]>`
      SELECT row_to_json(k)::text AS dump FROM integration_api_keys k WHERE id = ${issued.key.id}`;
    expect(stored.dump).not.toContain(encodedSecret);

    const listed = JSON.stringify(await service.list(member(tenant, 'owner')));
    expect(listed).not.toContain(encodedSecret);
    expect(listed).not.toContain(row.key_hash);
    expect(listed).not.toMatch(/hash|secret/i);

    await authenticate(`Bearer ${issued.secret}`);
    await service.revoke(member(tenant, 'owner'), issued.key.id);
    await authenticate(`Bearer ${issued.secret}`);
    const joined = logs.join('\n');
    expect(joined).toContain(issued.key.prefix);
    expect(joined).not.toContain(encodedSecret);
    expect(joined).not.toContain(row.key_hash);
  });

  it(`caps an integration at ${MAX_ACTIVE_INTEGRATION_API_KEYS} active keys, even under concurrent creates`, async () => {
    const tenant = await createTenant();
    const owner = member(tenant, 'owner');

    const statuses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        statusOf(service.create(owner, { name: `Server ${index}` })),
      ),
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(
      MAX_ACTIVE_INTEGRATION_API_KEYS,
    );
    expect(statuses.filter((status) => status === 409)).toHaveLength(3);
    const listed = await service.list(owner);
    expect(listed.keys).toHaveLength(MAX_ACTIVE_INTEGRATION_API_KEYS);

    // Revoking one frees a slot.
    await service.revoke(owner, listed.keys[0].id);
    await expect(
      statusOf(service.create(owner, { name: 'Replacement' })),
    ).resolves.toBe(200);
  });

  describe('authentication failures (uniform 401)', () => {
    it('refuses revoked, unknown and malformed keys and a key in the query string', async () => {
      const tenant = await createTenant();
      const owner = member(tenant, 'owner');
      const issued = await service.create(owner, { name: 'Shop server' });
      const unknown = `ak_live_zzzzzzzz_${issued.secret.slice(17)}`;

      await expect(
        authenticate(`Bearer ${issued.secret}`, { api_key: issued.secret }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(
        authenticate(undefined, { api_key: issued.secret }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(authenticate(`Bearer ${unknown}`)).resolves.toMatchObject({
        status: 401,
      });
      await expect(authenticate('Bearer ak_live_short')).resolves.toMatchObject(
        {
          status: 401,
        },
      );
      await expect(
        authenticate(`Bearer ${issued.secret}`),
      ).resolves.toMatchObject({ status: 200 });

      const revoked = await service.revoke(owner, issued.key.id);
      await expect(
        authenticate(`Bearer ${issued.secret}`),
      ).resolves.toMatchObject({ status: 401 });

      // Revocation is idempotent: the original time and actor stand.
      const again = await service.revoke(
        member(tenant, 'admin'),
        issued.key.id,
      );
      expect(again.revokedAt).toBe(revoked.revokedAt);
      expect((await keyRow(issued.key.id)).revoked_by).toBe(owner.userId);
    });
  });

  it('rotation under concurrent use: the old key fails as soon as its revocation commits, the new one keeps working', async () => {
    const tenant = await createTenant();
    const owner = member(tenant, 'owner');
    const oldKey = await service.create(owner, { name: 'Old' });
    const newKey = await service.create(owner, { name: 'New' });

    const inFlight = Array.from({ length: 20 }, (_, index) =>
      authenticate(`Bearer ${(index % 2 ? newKey : oldKey).secret}`),
    );
    const revocation = service.revoke(owner, oldKey.key.id);
    const [results] = await Promise.all([Promise.all(inFlight), revocation]);

    // New-key requests never fail; old-key requests either beat the
    // revocation or are refused, never anything else.
    const newStatuses = results.filter((_, index) => index % 2 === 1);
    const oldStatuses = results.filter((_, index) => index % 2 === 0);
    expect(newStatuses.map((result) => result.status)).toEqual(
      Array.from({ length: 10 }, () => 200),
    );
    expect(
      oldStatuses.every(
        (result) => result.status === 200 || result.status === 401,
      ),
    ).toBe(true);

    // After the revocation commits: always refused, every time.
    const after = await Promise.all(
      Array.from({ length: 10 }, () => authenticate(`Bearer ${oldKey.secret}`)),
    );
    expect(after.every((result) => result.status === 401)).toBe(true);
    await expect(
      authenticate(`Bearer ${newKey.secret}`),
    ).resolves.toMatchObject({ status: 200 });

    // Concurrent usage writes never undid the revocation.
    const old = await keyRow(oldKey.key.id);
    expect(old.revoked_at).not.toBeNull();
    expect(old.revoked_by).toBe(owner.userId);
  });

  it('writes last_used_at at most once a minute', async () => {
    const tenant = await createTenant();
    const issued = await service.create(member(tenant, 'owner'), {
      name: 'Shop server',
    });
    expect((await keyRow(issued.key.id)).last_used_at).toBeNull();

    await Promise.all(
      Array.from({ length: 5 }, () => authenticate(`Bearer ${issued.secret}`)),
    );
    const first = (await keyRow(issued.key.id)).last_used_at;
    expect(first).not.toBeNull();

    await authenticate(`Bearer ${issued.secret}`);
    expect((await keyRow(issued.key.id)).last_used_at).toEqual(first);

    await client`
      UPDATE integration_api_keys SET last_used_at = now() - interval '2 minutes'
      WHERE id = ${issued.key.id}`;
    const backdated = (await keyRow(issued.key.id)).last_used_at!;
    await authenticate(`Bearer ${issued.secret}`);
    const refreshed = (await keyRow(issued.key.id)).last_used_at!;
    expect(new Date(refreshed).getTime()).toBeGreaterThan(
      new Date(backdated).getTime(),
    );
  });

  it('RLS: members read their own metadata only, never the hash, and cannot write', async () => {
    const mine = await createTenant();
    const theirs = await createTenant();
    const myKey = await service.create(member(mine, 'owner'), { name: 'Mine' });
    await service.create(member(theirs, 'owner'), { name: 'Theirs' });

    async function asMember<T>(
      run: (tx: postgres.TransactionSql) => Promise<T>,
    ): Promise<T> {
      return (await client.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('akeed.test_org', $1, true)`, [
          mine.orgId,
        ]);
        await tx.unsafe('SET LOCAL ROLE authenticated');
        return run(tx);
      })) as T;
    }

    const visible = await asMember((tx) =>
      tx.unsafe<{ id: string }[]>(
        'SELECT id, prefix, name FROM integration_api_keys',
      ),
    );
    expect(visible.map((row) => row.id)).toEqual([myKey.key.id]);

    await expect(
      asMember((tx) => tx.unsafe('SELECT key_hash FROM integration_api_keys')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asMember((tx) =>
        tx.unsafe(
          `INSERT INTO integration_api_keys (org_id, integration_id, prefix, key_hash, name, created_by)
           VALUES ($1, $2, 'ak_live_forged00', $3, 'forged', $4)`,
          [mine.orgId, mine.integrationId, 'a'.repeat(64), randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asMember((tx) =>
        tx.unsafe('UPDATE integration_api_keys SET revoked_at = NULL'),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const [policy] = await client<{ cmd: string; qual: string }[]>`
      SELECT cmd, qual FROM pg_policies
      WHERE schemaname = ${namespace} AND tablename = 'integration_api_keys'`;
    expect(policy).toEqual({
      cmd: 'SELECT',
      qual: '(org_id = get_user_org_id())',
    });
  });

  it('enforces the stored shape in the database', async () => {
    const tenant = await createTenant();
    const insert = (prefix: string, keyHash: string, name: string) =>
      client`
        INSERT INTO integration_api_keys (org_id, integration_id, prefix, key_hash, name, created_by)
        VALUES (${tenant.orgId}, ${tenant.integrationId}, ${prefix}, ${keyHash}, ${name}, ${randomUUID()})`;

    await expect(
      insert('ak_live_ok000001', 'a'.repeat(64), 'ok'),
    ).resolves.toBeDefined();
    await expect(
      insert('ak_live_ok000001', 'b'.repeat(64), 'dup'),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insert('AK_LIVE_bad00000', 'a'.repeat(64), 'x'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert('ak_live_ok000002', 'not-a-hash', 'x'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert('ak_live_ok000003', 'a'.repeat(64), ''),
    ).rejects.toMatchObject({ code: '23514' });
    // A key cannot point at another organization's integration.
    const other = await createTenant();
    await expect(
      client`
        INSERT INTO integration_api_keys (org_id, integration_id, prefix, key_hash, name, created_by)
        VALUES (${tenant.orgId}, ${other.integrationId}, 'ak_live_ok000004', ${'a'.repeat(64)}, 'x', ${randomUUID()})`,
    ).rejects.toMatchObject({ code: '23503' });
  });
});
