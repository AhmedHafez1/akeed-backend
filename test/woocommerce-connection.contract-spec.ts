import { HttpException, Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import { StandaloneOrganizationProvisioningRepository } from '../src/infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { WooCommerceConnectionsRepository } from '../src/infrastructure/database/repositories/woocommerce-connections.repository';
import { WooCommerceApiClient } from '../src/infrastructure/spokes/woocommerce/woocommerce-api.client';
import { WooCommerceAuthService } from '../src/infrastructure/spokes/woocommerce/woocommerce-auth.service';
import { WooCommerceConnectionHealthService } from '../src/infrastructure/spokes/woocommerce/woocommerce-connection-health.service';
import { WooCommerceSetupContributor } from '../src/infrastructure/spokes/woocommerce/woocommerce-setup.contributor';
import { WooCommerceWebhookService } from '../src/infrastructure/spokes/woocommerce/woocommerce-webhook.service';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import {
  WOOCOMMERCE_CONFIG,
  type WooCommerceConfig,
} from '../src/shared/config/woocommerce.config';
import { createRestrictedHttp } from '../src/shared/http/restricted-http';
import { decryptToken } from '../src/shared/utils/token-encryption.util';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';
import {
  FAKE_PUBLIC_ADDRESS,
  FakeWooCommerce,
  type FakeWooCommerceStore,
} from './contracts/woocommerce-provider-fake';

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

const namespace = `e07_woocommerce_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 12,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const repository = new WooCommerceConnectionsRepository(database);
let created = false;

/** Synthetic, generated per run: never a real key. */
const ENCRYPTION_KEY = randomBytes(32).toString('hex');

const DELIVERY_BASE = 'https://api.akeed.test/api/woocommerce/webhooks/';

const settings: WooCommerceConfig & { pilotOrgIds: string[] } = {
  enabled: true,
  // Order ingestion is US-07-03 and has its own suite; here it stays off.
  ingestionEnabled: false,
  outcomeSyncEnabled: false,
  pilotOrgIds: [],
  publicApiBaseUrl: 'https://api.akeed.test',
  appBaseUrl: 'https://app.akeed.test',
};

const config = {
  get: (key: string) => (key === WOOCOMMERCE_CONFIG ? settings : undefined),
  getOrThrow: (key: string) => {
    if (key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY') return ENCRYPTION_KEY;
    throw new Error(`Unexpected configuration key ${key}`);
  },
} as unknown as ConfigService;

// The fake is the DNS and the transport of the real restricted client, so
// every store call below runs the production address checks.
const fake = new FakeWooCommerce();
const api = new WooCommerceApiClient(
  createRestrictedHttp({ lookup: fake.lookup, transport: fake.transport }),
);
const health = new WooCommerceConnectionHealthService(repository, api, config);
/** Waiting store updates a disconnect closed; the table is not in this suite. */
const closedSyncs: { orgId: string; integrationId: string; reason: string }[] =
  [];
const service = new WooCommerceAuthService(
  repository,
  api,
  config,
  {
    failPendingForIntegration: (
      orgId: string,
      integrationId: string,
      reason: string,
    ) => {
      closedSyncs.push({ orgId, integrationId, reason });
      return Promise.resolve(0);
    },
  } as never,
  health,
);
const contributor = new WooCommerceSetupContributor(repository, health);
// With ingestion off the delivery URL reads no event and writes none.
const webhooks = new WooCommerceWebhookService(
  repository,
  {} as never,
  {} as never,
  {} as never,
  config,
);

/** Every value that must never be logged, returned or stored in clear. */
const secrets = new Set<string>();
const responses: unknown[] = [];
const logs: string[] = [];
const stores: FakeWooCommerceStore[] = [];

interface Tenant {
  orgId: string;
  name: string;
}

async function createTenant(
  options: { pilot?: boolean } = {},
): Promise<Tenant> {
  const name = `Store ${randomUUID().slice(0, 8)}`;
  const [organization] = await client<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES (${name}, ${`org-${randomUUID()}`})
    RETURNING id`;
  if (options.pilot !== false) settings.pilotOrgIds.push(organization.id);
  return { orgId: organization.id, name };
}

function member(
  tenant: Tenant,
  role: AuthenticatedUser['role'] = 'owner',
  source: AuthenticatedUser['source'] = 'supabase',
): AuthenticatedUser {
  return { userId: randomUUID(), orgId: tenant.orgId, role, source };
}

function newStore(path = ''): FakeWooCommerceStore {
  const store = fake.addStore(path);
  stores.push(store);
  return store;
}

interface Keys {
  consumerKey: string;
  consumerSecret: string;
}

/** The merchant approves in the store, which issues the keys. */
function approve(
  store: FakeWooCommerceStore,
  options: { canManage?: boolean } = {},
): Keys {
  const keys = store.issueKeys(options);
  secrets.add(keys.consumerKey);
  secrets.add(keys.consumerSecret);
  return keys;
}

interface StartedInstall {
  callbackToken: string;
  installReference: string;
  expiresAt: string;
  authorizeUrl: string;
}

async function start(
  tenant: Tenant,
  store: FakeWooCommerceStore,
  user = member(tenant),
): Promise<StartedInstall> {
  const started = await service.startInstall(user, {
    storeUrl: store.url,
    locale: 'ar',
  });
  const params = new URL(started.authorizeUrl).searchParams;
  const callbackToken = params.get('callback_url')!.split('/').pop()!;
  secrets.add(callbackToken);
  return {
    callbackToken,
    installReference: params.get('user_id')!,
    expiresAt: started.expiresAt,
    authorizeUrl: started.authorizeUrl,
  };
}

/** The status and code the service answers with, or 200. */
async function outcome(
  promise: Promise<unknown>,
): Promise<{ status: number; code?: string }> {
  try {
    responses.push(await promise);
    return { status: 200 };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as { code?: string };
    responses.push(body);
    return { status: error.getStatus(), code: body.code };
  }
}

/** What the store posts after the merchant approves (finding 1.5). */
function callbackBody(
  started: StartedInstall,
  keys: Keys,
  overrides: Record<string, unknown> = {},
) {
  return {
    key_id: 1,
    user_id: started.installReference,
    consumer_key: keys.consumerKey,
    consumer_secret: keys.consumerSecret,
    key_permissions: 'read_write',
    ...overrides,
  };
}

function callback(
  started: StartedInstall,
  keys: Keys,
  overrides: Record<string, unknown> = {},
) {
  return outcome(
    service.handleCallback(
      started.callbackToken,
      callbackBody(started, keys, overrides),
    ),
  );
}

function deliver(token: string, topic?: string) {
  return outcome(webhooks.handleDelivery(token, { topic }, Buffer.alloc(0)));
}

async function status(tenant: Tenant, user = member(tenant)) {
  const result = await service.getStatus(user);
  responses.push(result);
  return result;
}

function integrationsOf(orgId: string) {
  return client<
    Record<string, unknown>[]
  >`SELECT * FROM integrations WHERE org_id = ${orgId} ORDER BY created_at`;
}

function connectionsOf(orgId: string) {
  return client<
    {
      integration_id: string;
      store_url: string;
      store_verified_at: Date | null;
      consumer_key_encrypted: string;
      consumer_secret_encrypted: string;
      webhook_secret_encrypted: string;
      webhook_token_hash: string;
      order_created_webhook_id: string;
      order_updated_webhook_id: string;
      order_created_webhook_state: string | null;
      order_updated_webhook_state: string | null;
      webhooks_checked_at: Date | null;
      disconnected_at: Date | null;
      disconnected_by: string | null;
      woo_version: string | null;
      health: string;
      rejected_deliveries: number;
      connected_by: string;
      connected_at: Date;
    }[]
  >`SELECT * FROM woocommerce_connections WHERE org_id = ${orgId}`;
}

function pendingOf(orgId: string) {
  return client<
    {
      id: string;
      store_url: string;
      attempts: number;
      consumed_at: Date | null;
      superseded_at: Date | null;
      claimed_until: Date | null;
      last_error_code: string | null;
      webhook_token_hash: string | null;
    }[]
  >`SELECT * FROM woocommerce_pending_installs WHERE org_id = ${orgId} ORDER BY created_at`;
}

async function expectNothingProvisioned(tenant: Tenant) {
  await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(0);
  await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(0);
}

const tokenOf = (deliveryUrl: string) => deliveryUrl.split('/').pop()!;
const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** The webhooks at a store that deliver to Akeed. */
function akeedWebhooks(store: FakeWooCommerceStore) {
  return [...store.webhooks.values()].filter((webhook) =>
    webhook.delivery_url.startsWith(DELIVERY_BASE),
  );
}

async function connect(path = '') {
  const tenant = await createTenant();
  const store = newStore(path);
  const started = await start(tenant, store);
  const keys = approve(store);
  await expect(callback(started, keys)).resolves.toEqual({ status: 200 });
  return { tenant, store, started, keys };
}

describe('WooCommerce connection PostgreSQL contract (US-07-02)', () => {
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
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        plan_type text DEFAULT 'free',
        wa_phone_number_id text,
        wa_business_account_id text,
        wa_access_token text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE memberships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        role text DEFAULT 'owner',
        created_at timestamptz DEFAULT now(),
        UNIQUE (org_id, user_id)
      );
      CREATE TABLE integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        access_token text,
        expires_at timestamptz,
        webhook_secret text,
        is_active boolean DEFAULT true,
        last_synced_at timestamptz,
        metadata jsonb DEFAULT '{}'::jsonb,
        store_name varchar(255),
        default_language text DEFAULT 'auto' NOT NULL,
        cod_template_ar_variant text DEFAULT 'standard' NOT NULL,
        cod_template_en_variant text DEFAULT 'friendly' NOT NULL,
        shipping_currency text DEFAULT 'USD' NOT NULL,
        avg_shipping_cost numeric(10,2) DEFAULT 3 NOT NULL,
        is_auto_verify_enabled boolean DEFAULT true NOT NULL,
        assume_cod_when_payment_missing boolean DEFAULT false NOT NULL,
        onboarding_status text DEFAULT 'pending' NOT NULL,
        billing_plan_id text,
        pending_billing_plan_id text,
        shopify_subscription_id text,
        billing_status text,
        billing_initiated_at timestamptz,
        billing_activated_at timestamptz,
        billing_canceled_at timestamptz,
        billing_status_updated_at timestamptz,
        follow_up_enabled boolean DEFAULT true NOT NULL,
        follow_up_delay_minutes integer DEFAULT 120 NOT NULL,
        escalation_enabled boolean DEFAULT true NOT NULL,
        escalation_delay_minutes integer DEFAULT 360 NOT NULL,
        quiet_hours_enabled boolean DEFAULT false NOT NULL,
        quiet_hours_start text,
        quiet_hours_end text,
        timezone text DEFAULT 'Asia/Riyadh' NOT NULL,
        send_delay_minutes integer DEFAULT 0 NOT NULL,
        country_code varchar(2),
        shop_timezone text,
        merchant_whatsapp_phone text,
        shop_phone text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        UNIQUE (platform_type, platform_store_url),
        UNIQUE (id, org_id),
        CONSTRAINT integrations_platform_type_check CHECK (platform_type = ANY (ARRAY['shopify', 'salla', 'zid', 'woocommerce', 'standalone', 'easyorders']))
      );
      CREATE UNIQUE INDEX integrations_one_active_source_per_org_idx ON integrations (org_id) WHERE is_active = true;
    `);
    // Applied twice: the migrations must be re-runnable.
    for (let pass = 0; pass < 2; pass++) {
      for (const name of [
        '0051_woocommerce_connection.sql',
        '0052_woocommerce_disconnect.sql',
      ])
        for (const statement of readFileSync(
          resolve(__dirname, '../drizzle', name),
          'utf8',
        ).split('--> statement-breakpoint')) {
          if (statement.trim()) await client.unsafe(statement);
        }
    }
    // Fault injection for the partial-failure case: while the flag row says
    // so, the credentials insert fails after the integration was inserted.
    await client.unsafe(`
      CREATE TABLE fault_switch (fail boolean NOT NULL);
      INSERT INTO fault_switch VALUES (false);
      CREATE FUNCTION fail_connection_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF (SELECT fail FROM fault_switch) THEN
          RAISE EXCEPTION 'injected connection insert failure';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER woocommerce_connections_fault BEFORE INSERT ON woocommerce_connections
        FOR EACH ROW EXECUTE FUNCTION fail_connection_insert();
      GRANT USAGE ON SCHEMA ${namespace} TO authenticated, anon;
    `);
  });

  afterAll(async () => {
    Logger.overrideLogger(['log', 'warn', 'error']);
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  describe('valid install', () => {
    it('provisions one woocommerce source with the pilot entitlement, the onboarding defaults, encrypted credentials and two webhooks', async () => {
      const tenant = await createTenant();
      const owner = member(tenant);
      const store = newStore();

      await expect(status(tenant)).resolves.toMatchObject({
        state: 'ready',
        storeUrl: null,
        connection: null,
      });
      const started = await start(tenant, store, owner);
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'pending',
        storeUrl: store.url,
        expiresAt: started.expiresAt,
        connection: null,
      });
      await expectNothingProvisioned(tenant);

      const keys = approve(store);
      const requestsBefore = fake.requestsTo(store).length;
      await expect(callback(started, keys)).resolves.toEqual({ status: 200 });

      // The proof, the list and the two creations: nothing else is sent.
      expect(
        fake
          .requestsTo(store)
          .slice(requestsBefore)
          .map((request) => request.route),
      ).toEqual(['system_status', 'list', 'create', 'create']);

      const sources = await integrationsOf(tenant.orgId);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        platform_type: 'woocommerce',
        platform_store_url: `woocommerce:${tenant.orgId}`,
        is_active: true,
        access_token: null,
        webhook_secret: null,
        store_name: tenant.name,
        onboarding_status: 'pending',
        billing_status: 'not_required',
        billing_plan_id: 'starter',
        is_auto_verify_enabled: true,
        assume_cod_when_payment_missing: false,
        send_delay_minutes: 0,
        follow_up_enabled: true,
        follow_up_delay_minutes: 120,
        escalation_enabled: true,
        escalation_delay_minutes: 360,
        quiet_hours_enabled: false,
      });
      expect(sources[0].billing_activated_at).not.toBeNull();

      const registered = akeedWebhooks(store);
      expect(registered.map((webhook) => webhook.topic).sort()).toEqual([
        'order.created',
        'order.updated',
      ]);
      expect(registered.map((webhook) => webhook.name).sort()).toEqual([
        'Akeed order created',
        'Akeed order updated',
      ]);
      expect(registered.every((webhook) => webhook.status === 'active')).toBe(
        true,
      );
      const [first, second] = registered;
      expect(first.delivery_url).toMatch(
        /^https:\/\/api\.akeed\.test\/api\/woocommerce\/webhooks\/[A-Za-z0-9_-]{43}$/,
      );
      expect(second.delivery_url).toBe(first.delivery_url);
      expect(second.secret).toBe(first.secret);
      expect(Buffer.from(first.secret, 'base64url')).toHaveLength(32);
      const webhookToken = tokenOf(first.delivery_url);
      expect(webhookToken).not.toBe(started.callbackToken);

      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection).toMatchObject({
        integration_id: sources[0].id,
        store_url: store.url,
        health: 'ok',
        woo_version: '9.8.1',
        rejected_deliveries: 0,
        connected_by: owner.userId,
        webhook_token_hash: sha256(webhookToken),
      });
      expect(connection.store_verified_at).not.toBeNull();
      expect(connection.connected_at).not.toBeNull();
      expect(
        [
          Number(connection.order_created_webhook_id),
          Number(connection.order_updated_webhook_id),
        ].sort(),
      ).toEqual(registered.map((webhook) => webhook.id).sort());
      expect(Number(connection.order_created_webhook_id)).toBe(
        registered.find((webhook) => webhook.topic === 'order.created')!.id,
      );
      for (const [column, plain] of [
        [connection.consumer_key_encrypted, keys.consumerKey],
        [connection.consumer_secret_encrypted, keys.consumerSecret],
        [connection.webhook_secret_encrypted, first.secret],
      ]) {
        expect(column).toMatch(/^v1:/);
        expect(decryptToken(column, ENCRYPTION_KEY)).toBe(plain);
      }

      const [pending] = await pendingOf(tenant.orgId);
      expect(pending.consumed_at).not.toBeNull();
      expect(pending.claimed_until).toBeNull();

      await expect(status(tenant)).resolves.toEqual({
        state: 'connected',
        canManage: true,
        organizationName: tenant.name,
        storeUrl: store.url,
        expiresAt: null,
        lastErrorCode: null,
        connection: {
          storeUrl: store.url,
          health: 'ok',
          connectedAt: expect.any(String) as string,
          rejectedDeliveries: 0,
          webhooks: [
            { kind: 'order_created', state: 'active' },
            { kind: 'order_updated', state: 'active' },
          ],
          webhooksCheckedAt: expect.any(String) as string,
          disconnectedAt: null,
        },
      });
    });

    it('connects a store in a subdirectory, with every call under its path', async () => {
      const { tenant, store } = await connect('/shop/eg');

      expect(store.url).toMatch(/\/shop\/eg$/);
      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection.store_url).toBe(store.url);
      expect(akeedWebhooks(store)).toHaveLength(2);
      // The fake answers 404 outside the store's own path.
      expect(
        fake.requestsTo(store).every((request) => request.answered !== 404),
      ).toBe(true);
    });

    it('lets an admin connect', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store, member(tenant, 'admin'));

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 200,
      });
    });

    it('accepts the store calling itself by the same address with a trailing slash', async () => {
      const tenant = await createTenant();
      const store = newStore();
      store.homeUrl = `${store.url}/`;
      const started = await start(tenant, store);

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 200,
      });
    });

    it('accepts user_id coming back as a JSON number', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);

      await expect(
        callback(started, approve(store), {
          user_id: Number(started.installReference),
        }),
      ).resolves.toEqual({ status: 200 });
    });
  });

  describe('the authorize link', () => {
    it('asks for read_write on the entered store and carries only the callback token', async () => {
      const tenant = await createTenant();
      const store = newStore('/shop');
      const started = await service.startInstall(member(tenant), {
        storeUrl: `  ${store.url.replace('https://', 'HTTPS://')}/  `,
        locale: 'en',
      });
      const url = new URL(started.authorizeUrl);
      secrets.add(tokenOf(url.searchParams.get('callback_url')!));

      expect(started.storeUrl).toBe(store.url);
      expect(
        started.authorizeUrl.startsWith(`${store.url}/wc-auth/v1/authorize?`),
      ).toBe(true);
      expect([...url.searchParams.keys()].sort()).toEqual([
        'app_name',
        'callback_url',
        'return_url',
        'scope',
        'user_id',
      ]);
      expect(url.searchParams.get('app_name')).toBe('Akeed');
      expect(url.searchParams.get('scope')).toBe('read_write');
      expect(url.searchParams.get('user_id')).toMatch(/^[1-9][0-9]{14}$/);
      expect(url.searchParams.get('return_url')).toBe(
        'https://app.akeed.test/en/onboarding',
      );
      expect(url.searchParams.get('callback_url')).toMatch(
        /^https:\/\/api\.akeed\.test\/api\/woocommerce\/install\/callback\/[A-Za-z0-9_-]{43}$/,
      );
      expect(started.authorizeUrl).not.toContain('webhooks');

      // Only hashes of it are stored, and no webhook token exists yet.
      const [pending] = await pendingOf(tenant.orgId);
      expect(pending.store_url).toBe(store.url);
      expect(pending.webhook_token_hash).toBeNull();
    });
  });

  describe('who may connect', () => {
    it('refuses a viewer, who can still read the status', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const viewer = member(tenant, 'viewer');
      const before = fake.requests.length;

      await expect(
        outcome(
          service.startInstall(viewer, { storeUrl: store.url, locale: 'en' }),
        ),
      ).resolves.toEqual({ status: 403, code: 'WOOCOMMERCE_ROLE_REQUIRED' });
      await expect(status(tenant, viewer)).resolves.toMatchObject({
        state: 'ready',
        canManage: false,
      });
      await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
      expect(fake.requests).toHaveLength(before);
    });

    it('refuses an embedded Shopify session', async () => {
      const tenant = await createTenant();

      await expect(
        outcome(
          service.startInstall(member(tenant, 'owner', 'shopify'), {
            storeUrl: newStore().url,
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({
        status: 403,
        code: 'WOOCOMMERCE_SESSION_REQUIRED',
      });
    });

    it('refuses an organization that is not on the pilot allow-list, without calling the store', async () => {
      const tenant = await createTenant({ pilot: false });
      const before = fake.requests.length;

      await expect(
        outcome(
          service.startInstall(member(tenant), {
            storeUrl: newStore().url,
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({ status: 403, code: 'WOOCOMMERCE_PILOT_REQUIRED' });
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'pilot_required',
      });
      expect(fake.requests).toHaveLength(before);
    });

    it('refuses everything while the switch is off, including a callback on an open context', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);
      const before = fake.requests.length;
      settings.enabled = false;
      try {
        await expect(
          outcome(
            service.startInstall(member(tenant), {
              storeUrl: store.url,
              locale: 'en',
            }),
          ),
        ).resolves.toEqual({
          status: 404,
          code: 'WOOCOMMERCE_CONNECT_UNAVAILABLE',
        });
        await expect(callback(started, keys)).resolves.toEqual({
          status: 404,
          code: 'WOOCOMMERCE_CONNECT_UNAVAILABLE',
        });
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'unavailable',
        });
      } finally {
        settings.enabled = true;
      }
      expect(fake.requests).toHaveLength(before);
      await expectNothingProvisioned(tenant);
    });

    it('keeps a connection readable with the switch off', async () => {
      const { tenant, store } = await connect();
      settings.enabled = false;
      try {
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'connected',
          storeUrl: store.url,
        });
      } finally {
        settings.enabled = true;
      }
    });

    it('stops honouring an open context once the organization leaves the allow-list', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      settings.pilotOrgIds.splice(
        settings.pilotOrgIds.indexOf(tenant.orgId),
        1,
      );

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });
      await expectNothingProvisioned(tenant);
    });
  });

  describe('store address', () => {
    it.each([
      ['plain HTTP', 'http://shop.example.com', 'HTTPS_REQUIRED'],
      ['no scheme', 'shop.example.com', 'URL_INVALID'],
      ['credentials', 'https://a:b@shop.example.com', 'URL_INVALID'],
      ['a query', 'https://shop.example.com/?x=1', 'URL_INVALID'],
      ['another port', 'https://shop.example.com:8443', 'URL_INVALID'],
      ['a private address literal', 'https://10.0.0.5', 'URL_INVALID'],
      ['a loopback literal', 'https://127.0.0.1', 'URL_INVALID'],
      ['the metadata address', 'https://169.254.169.254', 'URL_INVALID'],
      ['localhost', 'https://localhost', 'URL_INVALID'],
      ['a dot segment', 'https://shop.example.com/a/../b', 'URL_INVALID'],
      ['the REST path', 'https://shop.example.com/wp-json', 'URL_INVALID'],
    ])(
      'refuses %s with its own code, without a request',
      async (_label, storeUrl, code) => {
        const tenant = await createTenant();
        const before = fake.requests.length;

        await expect(
          outcome(
            service.startInstall(member(tenant), { storeUrl, locale: 'en' }),
          ),
        ).resolves.toEqual({ status: 400, code: `WOOCOMMERCE_STORE_${code}` });
        await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
        expect(fake.requests).toHaveLength(before);
      },
    );
  });

  describe('SSRF at start', () => {
    it.each([
      ['a private address', ['10.4.5.6']],
      ['loopback', ['127.0.0.1']],
      ['a link-local address', ['169.254.169.254']],
      ['an IPv6 unique-local address', ['fd00::5']],
      ['an IPv4-mapped loopback address', ['::ffff:127.0.0.1']],
      [
        'a public and a private address together',
        [FAKE_PUBLIC_ADDRESS, '10.0.0.9'],
      ],
    ])(
      'refuses a name that resolves to %s and connects to nothing',
      async (_label, addresses) => {
        const tenant = await createTenant();
        const host = `internal-${randomBytes(4).toString('hex')}.example.com`;
        fake.bareHosts.set(host, addresses);
        const before = fake.requests.length;

        await expect(
          outcome(
            service.startInstall(member(tenant), {
              storeUrl: `https://${host}`,
              locale: 'en',
            }),
          ),
        ).resolves.toEqual({
          status: 422,
          code: 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC',
        });
        await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
        expect(fake.requests).toHaveLength(before);
      },
    );

    it('refuses a name that does not resolve', async () => {
      const tenant = await createTenant();

      await expect(
        outcome(
          service.startInstall(member(tenant), {
            storeUrl: 'https://no-such-host.example.com',
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC',
      });
      await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
    });

    it('refuses a redirect to a private address and never follows it', async () => {
      const tenant = await createTenant();
      const store = newStore();
      store.redirectTo = 'https://169.254.169.254/latest/meta-data/';
      const before = fake.requests.length;

      await expect(
        outcome(
          service.startInstall(member(tenant), {
            storeUrl: store.url,
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({ status: 422, code: 'WOOCOMMERCE_STORE_REDIRECTS' });

      // One request, to the store, and nothing after it.
      expect(fake.requests.slice(before)).toEqual([
        expect.objectContaining({ host: store.host, answered: 301 }),
      ]);
      await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
    });

    it('refuses an invalid TLS certificate', async () => {
      const tenant = await createTenant();
      const store = newStore();
      store.validCertificate = false;

      await expect(
        outcome(
          service.startInstall(member(tenant), {
            storeUrl: store.url,
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({ status: 422, code: 'WOOCOMMERCE_STORE_TLS_FAILED' });
      await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
    });
  });

  describe('unsupported store', () => {
    it('refuses a store whose REST API is not there (plain permalinks)', async () => {
      const tenant = await createTenant();
      const store = newStore();
      store.permalinks = false;

      await expect(
        outcome(
          service.startInstall(member(tenant), {
            storeUrl: store.url,
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({ status: 422, code: 'WOOCOMMERCE_REST_NOT_FOUND' });
      await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
    });

    it.each([
      ['does not answer', (store: FakeWooCommerceStore) => (store.down = true)],
      [
        'answers 500',
        (store: FakeWooCommerceStore) => store.failNext('index', 500),
      ],
      [
        'answers 503',
        (store: FakeWooCommerceStore) => store.failNext('index', 503),
      ],
    ])('refuses a store that %s', async (_label, breakStore) => {
      const tenant = await createTenant();
      const store = newStore();
      breakStore(store);

      await expect(
        outcome(
          service.startInstall(member(tenant), {
            storeUrl: store.url,
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({ status: 503, code: 'WOOCOMMERCE_REST_UNREACHABLE' });
      await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(0);
    });

    it.each([401, 403, 400])(
      'lets the merchant continue when the unauthenticated index answers %i',
      async (indexStatus) => {
        const tenant = await createTenant();
        const store = newStore();
        store.failNext('index', indexStatus);

        await expect(start(tenant, store)).resolves.toMatchObject({
          installReference: expect.stringMatching(/^[1-9][0-9]{14}$/) as string,
        });
      },
    );
  });

  describe('install context', () => {
    it('rejects an expired context without mutation and without calling the store', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      await client`UPDATE woocommerce_pending_installs SET expires_at = now() - interval '1 second' WHERE org_id = ${tenant.orgId}`;
      const before = fake.requests.length;

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });

      // The keys are not even sent to the store for a dead context.
      expect(fake.requests).toHaveLength(before);
      await expectNothingProvisioned(tenant);
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'expired',
        storeUrl: store.url,
      });
    });

    it('rejects a replayed callback and leaves the connection and the webhooks untouched', async () => {
      const { tenant, store, started } = await connect();
      const [before] = await connectionsOf(tenant.orgId);
      const webhooksBefore = akeedWebhooks(store).map((webhook) => webhook.id);
      const requestsBefore = fake.requests.length;

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });

      expect(fake.requests).toHaveLength(requestsBefore);
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      const [after] = await connectionsOf(tenant.orgId);
      expect(after).toEqual(before);
      expect(akeedWebhooks(store).map((webhook) => webhook.id)).toEqual(
        webhooksBefore,
      );
    });

    it.each([
      ['an unknown token', randomBytes(32).toString('base64url')],
      ['a malformed token', 'not-a-token'],
      ['an empty token', ''],
    ])('rejects %s', async (_label, token) => {
      const store = newStore();
      const keys = approve(store);

      await expect(
        outcome(
          service.handleCallback(token, {
            user_id: '123456789012345',
            consumer_key: keys.consumerKey,
            consumer_secret: keys.consumerSecret,
            key_permissions: 'read_write',
          }),
        ),
      ).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });
    });

    it('retires the earlier context when a new install is started', async () => {
      const tenant = await createTenant();
      const firstStore = newStore();
      const secondStore = newStore();
      const first = await start(tenant, firstStore);
      const second = await start(tenant, secondStore);

      await expect(callback(first, approve(firstStore))).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });
      await expectNothingProvisioned(tenant);
      expect(akeedWebhooks(firstStore)).toHaveLength(0);

      await expect(callback(second, approve(secondStore))).resolves.toEqual({
        status: 200,
      });
      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection.store_url).toBe(secondStore.url);
    });

    it.each([
      ['no body', () => undefined],
      ['an array', () => []],
      [
        'a missing key',
        (body: Record<string, unknown>) => ({
          ...body,
          consumer_key: undefined,
        }),
      ],
      [
        'a missing secret',
        (body: Record<string, unknown>) => ({
          ...body,
          consumer_secret: undefined,
        }),
      ],
      [
        'a non-string key',
        (body: Record<string, unknown>) => ({ ...body, consumer_key: 42 }),
      ],
      [
        'a key with spaces',
        (body: Record<string, unknown>) => ({ ...body, consumer_key: 'a b' }),
      ],
      [
        'an oversized secret',
        (body: Record<string, unknown>) => ({
          ...body,
          consumer_secret: 'x'.repeat(513),
        }),
      ],
      [
        'no user_id',
        (body: Record<string, unknown>) => ({ ...body, user_id: undefined }),
      ],
      [
        'another user_id',
        (body: Record<string, unknown>) => ({
          ...body,
          user_id: '999999999999999',
        }),
      ],
      [
        'a user_id that is not a number',
        (body: Record<string, unknown>) => ({
          ...body,
          user_id: { $ne: null },
        }),
      ],
    ])(
      'rejects a callback with %s, without calling the store',
      async (_label, shape) => {
        const tenant = await createTenant();
        const store = newStore();
        const started = await start(tenant, store);
        const before = fake.requests.length;

        await expect(
          outcome(
            service.handleCallback(
              started.callbackToken,
              shape(callbackBody(started, approve(store))),
            ),
          ),
        ).resolves.toEqual({
          status: 400,
          code: 'WOOCOMMERCE_CALLBACK_INVALID',
        });
        expect(fake.requests).toHaveLength(before);
        await expectNothingProvisioned(tenant);
      },
    );

    it('refuses a second callback while one is running, without counting an attempt', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);
      // As the first callback leaves it while its store calls are running.
      await client`UPDATE woocommerce_pending_installs SET claimed_until = now() + interval '30 seconds' WHERE org_id = ${tenant.orgId}`;
      const before = fake.requests.length;

      await expect(callback(started, keys)).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });
      expect(fake.requests).toHaveLength(before);
      const [held] = await pendingOf(tenant.orgId);
      expect(held.attempts).toBe(0);
      expect(held.last_error_code).toBeNull();

      // A claim whose holder died lapses by itself.
      await client`UPDATE woocommerce_pending_installs SET claimed_until = now() - interval '1 second' WHERE org_id = ${tenant.orgId}`;
      await expect(callback(started, keys)).resolves.toEqual({ status: 200 });
    });
  });

  describe('credential check', () => {
    it('rejects keys the store answers 401 for, without mutation', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);
      store.revokeKey(keys.consumerKey);

      await expect(callback(started, keys)).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
      });

      await expectNothingProvisioned(tenant);
      expect(akeedWebhooks(store)).toHaveLength(0);
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'failed',
        storeUrl: store.url,
        lastErrorCode: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
      });
    });

    it('rejects keys whose user may not manage WooCommerce (403)', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);

      await expect(
        callback(started, approve(store, { canManage: false })),
      ).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_PERMISSION_DENIED',
      });
      await expectNothingProvisioned(tenant);
    });

    it.each(['read', 'write', undefined, 7])(
      'rejects key_permissions %p before calling the store',
      async (keyPermissions) => {
        const tenant = await createTenant();
        const store = newStore();
        const started = await start(tenant, store);
        const before = fake.requests.length;

        await expect(
          callback(started, approve(store), {
            key_permissions: keyPermissions,
          }),
        ).resolves.toEqual({
          status: 422,
          code: 'WOOCOMMERCE_PERMISSION_DENIED',
        });
        expect(fake.requests).toHaveLength(before);
        await expectNothingProvisioned(tenant);
      },
    );

    it('rejects a store that reports another address', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      store.homeUrl = `https://www.${store.host}`;

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_STORE_URL_MISMATCH',
      });
      await expectNothingProvisioned(tenant);
      expect(akeedWebhooks(store)).toHaveLength(0);
      // The store's own value is not kept anywhere.
      secrets.add(`www.${store.host}`);
    });

    it.each([
      [
        'plain HTTP',
        (store: FakeWooCommerceStore) =>
          store.url.replace('https://', 'http://'),
      ],
      ['a subdirectory', (store: FakeWooCommerceStore) => `${store.url}/blog`],
      ['something that is not a URL', () => 'not a url'],
    ])('rejects a store that reports %s', async (_label, reported) => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      store.homeUrl = reported(store);

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_STORE_URL_MISMATCH',
      });
      await expectNothingProvisioned(tenant);
    });

    it('kills a context after five refused callbacks, even for good keys', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      for (let attempt = 0; attempt < 5; attempt++) {
        const keys = approve(store);
        store.revokeKey(keys.consumerKey);
        await callback(started, keys);
      }

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 401,
        code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
      });
      await expectNothingProvisioned(tenant);
    });

    it('stores nothing when the store cannot be reached, and the same link works on retry', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);
      store.down = true;

      await expect(callback(started, keys)).resolves.toEqual({
        status: 503,
        code: 'WOOCOMMERCE_REST_UNREACHABLE',
      });
      await expectNothingProvisioned(tenant);
      const [pending] = await pendingOf(tenant.orgId);
      expect(pending).toMatchObject({ attempts: 1, claimed_until: null });

      store.down = false;
      await expect(callback(started, keys)).resolves.toEqual({ status: 200 });
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
    });
  });

  describe('SSRF at the callback', () => {
    it.each([
      ['a private address', ['192.168.1.20']],
      ['loopback', ['127.0.0.1']],
      ['a link-local address', ['169.254.169.254']],
      [
        'a public and a private address together',
        [FAKE_PUBLIC_ADDRESS, '10.0.0.9'],
      ],
    ])(
      'refuses a store whose name now resolves to %s, and the keys go nowhere',
      async (_label, addresses) => {
        const tenant = await createTenant();
        const store = newStore();
        const started = await start(tenant, store);
        const keys = approve(store);
        // DNS rebinding: public when the install started, not any more.
        store.addresses = addresses;
        const before = fake.requests.length;

        await expect(callback(started, keys)).resolves.toEqual({
          status: 422,
          code: 'WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC',
        });
        expect(fake.requests).toHaveLength(before);
        await expectNothingProvisioned(tenant);
      },
    );

    it('refuses a store that now redirects, and never follows it', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);
      store.redirectTo = 'https://10.0.0.1/steal';
      const before = fake.requests.length;

      await expect(callback(started, keys)).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_STORE_REDIRECTS',
      });
      expect(fake.requests.slice(before)).toEqual([
        expect.objectContaining({ host: store.host, answered: 301 }),
      ]);
      await expectNothingProvisioned(tenant);
    });

    it('refuses a store whose certificate is no longer valid', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);
      store.validCertificate = false;

      await expect(callback(started, keys)).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_STORE_TLS_FAILED',
      });
      await expectNothingProvisioned(tenant);
    });

    it('sends every request to an address the name resolved to', () => {
      expect(fake.requests.length).toBeGreaterThan(50);
      expect(
        fake.requests.every(
          (request) => request.address === FAKE_PUBLIC_ADDRESS,
        ),
      ).toBe(true);
    });
  });

  describe('store binding', () => {
    it('proves the keys against the store of the install, so keys for another store connect nothing', async () => {
      const tenant = await createTenant();
      const boundStore = newStore();
      const otherStore = newStore();
      const started = await start(tenant, boundStore);
      const before = fake.requestsTo(otherStore).length;

      // Valid keys, issued by a store the install is not for.
      await expect(callback(started, approve(otherStore))).resolves.toEqual({
        status: 422,
        code: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
      });

      await expectNothingProvisioned(tenant);
      expect(fake.requestsTo(otherStore)).toHaveLength(before);
      expect(akeedWebhooks(otherStore)).toHaveLength(0);
    });

    it('rejects a store that is connected to another organization and leaves that connection and its webhooks untouched', async () => {
      const { tenant: owner, store } = await connect();
      const [before] = await connectionsOf(owner.orgId);
      const webhooksBefore = akeedWebhooks(store).map((webhook) => webhook.id);

      const second = await createTenant();
      const started = await start(second, store);
      const requestsBefore = fake.requestsTo(store).length;
      // The second organization holds keys that really work on the store.
      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 409,
        code: 'WOOCOMMERCE_STORE_UNAVAILABLE',
      });

      // Refused before any store call: the owner's webhooks are not touched.
      expect(fake.requestsTo(store)).toHaveLength(requestsBefore);
      expect(akeedWebhooks(store).map((webhook) => webhook.id)).toEqual(
        webhooksBefore,
      );
      await expectNothingProvisioned(second);
      const [after] = await connectionsOf(owner.orgId);
      expect(after).toEqual(before);
      await expect(status(second)).resolves.toMatchObject({
        state: 'failed',
        lastErrorCode: 'WOOCOMMERCE_STORE_UNAVAILABLE',
      });
    });

    it('lets one of two organizations racing for the same store win, and only one', async () => {
      const store = newStore();
      store.latencyMs = 3;
      const first = await createTenant();
      const second = await createTenant();
      const firstInstall = await start(first, store);
      const secondInstall = await start(second, store);

      const results = await Promise.all([
        callback(firstInstall, approve(store)),
        callback(secondInstall, approve(store)),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const rows = await client`
        SELECT org_id FROM woocommerce_connections WHERE store_url = ${store.url}`;
      expect(rows).toHaveLength(1);
      const sources = await client`
        SELECT id FROM integrations WHERE org_id IN ${client([first.orgId, second.orgId])}`;
      expect(sources).toHaveLength(1);
    });

    it('holds a verified store for one integration at the database', async () => {
      const { store } = await connect();
      const other = await createTenant();
      const [integration] = await client<{ id: string }[]>`
        INSERT INTO integrations (org_id, platform_type, platform_store_url)
        VALUES (${other.orgId}, 'woocommerce', ${`woocommerce:${other.orgId}`})
        RETURNING id`;

      await expect(
        client`
          INSERT INTO woocommerce_connections (
            integration_id, org_id, store_url, store_verified_at,
            consumer_key_encrypted, consumer_secret_encrypted,
            webhook_secret_encrypted, webhook_token_hash,
            order_created_webhook_id, order_updated_webhook_id, connected_by
          ) VALUES (
            ${integration.id}, ${other.orgId}, ${store.url}, now(),
            'v1:a', 'v1:b', 'v1:c', ${sha256(randomUUID())}, 1, 2, ${randomUUID()}
          )`,
      ).rejects.toThrow(/woocommerce_connections_verified_store_key/);
    });
  });

  describe('tenant isolation', () => {
    it('a callback provisions only the organization that started the install, and another tenant sees nothing of it', async () => {
      const tenantB = await createTenant();
      const { tenant: tenantA, store } = await connect();

      await expectNothingProvisioned(tenantB);
      await expect(status(tenantB)).resolves.toEqual({
        state: 'ready',
        canManage: true,
        organizationName: tenantB.name,
        storeUrl: null,
        expiresAt: null,
        lastErrorCode: null,
        connection: null,
      });
      await expect(status(tenantA)).resolves.toMatchObject({
        state: 'connected',
        storeUrl: store.url,
      });
    });

    it("a pending install's store is shown only to its own organization", async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const store = newStore();
      await start(tenantA, store);

      await expect(status(tenantB)).resolves.toMatchObject({
        state: 'ready',
        storeUrl: null,
      });
    });
  });

  describe('existing source', () => {
    it.each(['standalone', 'shopify', 'easyorders'] as const)(
      'refuses to start for an organization with an active %s source, without calling the store',
      async (platform) => {
        const tenant = await createTenant();
        await client`
          INSERT INTO integrations (org_id, platform_type, platform_store_url)
          VALUES (${tenant.orgId}, ${platform}, ${`${platform}:${tenant.orgId}`})`;
        const [before] = await integrationsOf(tenant.orgId);
        const requestsBefore = fake.requests.length;

        await expect(
          outcome(
            service.startInstall(member(tenant), {
              storeUrl: newStore().url,
              locale: 'en',
            }),
          ),
        ).resolves.toEqual({ status: 409, code: 'WOOCOMMERCE_SOURCE_EXISTS' });
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'source_exists',
        });
        expect(fake.requests).toHaveLength(requestsBefore);
        await expect(integrationsOf(tenant.orgId)).resolves.toEqual([before]);
      },
    );

    it('refuses an inactive source of another platform: there is no source switching', async () => {
      const tenant = await createTenant();
      await client`
        INSERT INTO integrations (org_id, platform_type, platform_store_url, is_active)
        VALUES (${tenant.orgId}, 'standalone', ${`standalone:${tenant.orgId}`}, false)`;

      await expect(
        outcome(
          service.startInstall(member(tenant), {
            storeUrl: newStore().url,
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({ status: 409, code: 'WOOCOMMERCE_SOURCE_EXISTS' });
    });

    it('rejects a callback when a source appeared after the install was started, and leaves nothing at the store', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      await client`
        INSERT INTO integrations (org_id, platform_type, platform_store_url)
        VALUES (${tenant.orgId}, 'standalone', ${`standalone:${tenant.orgId}`})`;
      const [before] = await integrationsOf(tenant.orgId);

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 409,
        code: 'WOOCOMMERCE_SOURCE_EXISTS',
      });

      await expect(integrationsOf(tenant.orgId)).resolves.toEqual([before]);
      await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(0);
      // The webhooks it had created are removed again.
      expect(akeedWebhooks(store)).toHaveLength(0);
    });
  });

  describe('webhook creation', () => {
    it.each([
      ['the first', 0],
      ['the second', 1],
    ])(
      'leaves nothing half-connected when %s webhook cannot be created, and the same link then succeeds',
      async (_label, skip) => {
        const tenant = await createTenant();
        const store = newStore();
        const started = await start(tenant, store);
        const keys = approve(store);
        store.failNext('create', 500, skip);

        await expect(callback(started, keys)).resolves.toEqual({
          status: 503,
          code: 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED',
        });

        await expectNothingProvisioned(tenant);
        expect(akeedWebhooks(store)).toHaveLength(0);
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'failed',
          lastErrorCode: 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED',
        });

        await expect(callback(started, keys)).resolves.toEqual({ status: 200 });
        expect(akeedWebhooks(store)).toHaveLength(2);
        const [connection] = await connectionsOf(tenant.orgId);
        expect(
          [
            Number(connection.order_created_webhook_id),
            Number(connection.order_updated_webhook_id),
          ].sort(),
        ).toEqual(
          akeedWebhooks(store)
            .map((webhook) => webhook.id)
            .sort(),
        );
      },
    );

    it('replaces a webhook left behind by an earlier attempt instead of adding to it', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);
      // The second creation fails and so does removing the first.
      store.failNext('create', 500, 1);
      store.failNext('delete', 500);

      await expect(callback(started, keys)).resolves.toEqual({
        status: 503,
        code: 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED',
      });
      const [leftover] = akeedWebhooks(store);
      expect(akeedWebhooks(store)).toHaveLength(1);
      await expectNothingProvisioned(tenant);

      await expect(callback(started, keys)).resolves.toEqual({ status: 200 });
      const registered = akeedWebhooks(store);
      expect(registered).toHaveLength(2);
      expect(registered.map((webhook) => webhook.id)).not.toContain(
        leftover.id,
      );
      // A retry registers a fresh address and a fresh secret.
      expect(registered[0].delivery_url).not.toBe(leftover.delivery_url);
      expect(registered[0].secret).not.toBe(leftover.secret);
    });

    it("removes Akeed's own webhooks from every page and leaves other apps' webhooks alone", async () => {
      const tenant = await createTenant();
      const store = newStore();
      const foreign: number[] = [];
      for (let index = 0; index < 120; index++)
        foreign.push(
          store.addForeignWebhook(
            `https://other-app.example.net/hook/${index}`,
          ),
        );
      // On the second page of 100.
      const stale = store.addForeignWebhook(`${DELIVERY_BASE}stale-token`);
      const started = await start(tenant, store);
      const before = fake.requestsTo(store).length;

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 200,
      });

      expect(
        fake
          .requestsTo(store)
          .slice(before)
          .map((request) => request.route),
      ).toEqual([
        'system_status',
        'list',
        'list',
        'delete',
        'create',
        'create',
      ]);
      expect(store.webhooks.has(stale)).toBe(false);
      expect(foreign.every((id) => store.webhooks.has(id))).toBe(true);
      expect(akeedWebhooks(store)).toHaveLength(2);
    });

    it.each([
      ['the list fails', 'list', 500, 503, 'WOOCOMMERCE_WEBHOOK_SETUP_FAILED'],
      [
        'the list is forbidden',
        'list',
        403,
        422,
        'WOOCOMMERCE_PERMISSION_DENIED',
      ],
      [
        'a creation is forbidden',
        'create',
        403,
        422,
        'WOOCOMMERCE_PERMISSION_DENIED',
      ],
      [
        'the host refuses the method',
        'create',
        501,
        503,
        'WOOCOMMERCE_WEBHOOK_SETUP_FAILED',
      ],
    ] as const)(
      'stores nothing when %s',
      async (_label, route, answered, expectedStatus, code) => {
        const tenant = await createTenant();
        const store = newStore();
        const started = await start(tenant, store);
        store.failNext(route, answered);

        await expect(callback(started, approve(store))).resolves.toEqual({
          status: expectedStatus,
          code,
        });
        await expectNothingProvisioned(tenant);
        expect(akeedWebhooks(store)).toHaveLength(0);
      },
    );
  });

  describe('concurrency and partial failure', () => {
    it('two callbacks on one link produce one source and exactly its two webhooks', async () => {
      const tenant = await createTenant();
      const store = newStore();
      store.latencyMs = 3;
      const started = await start(tenant, store);

      const results = await Promise.all([
        callback(started, approve(store)),
        callback(started, approve(store)),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      const [connection] = await connectionsOf(tenant.orgId);
      const registered = akeedWebhooks(store);
      expect(registered).toHaveLength(2);
      expect(
        [
          Number(connection.order_created_webhook_id),
          Number(connection.order_updated_webhook_id),
        ].sort(),
      ).toEqual(registered.map((webhook) => webhook.id).sort());
      expect(connection.webhook_token_hash).toBe(
        sha256(tokenOf(registered[0].delivery_url)),
      );
    });

    it('two open contexts for one organization produce one source, and the loser leaves nothing at its store', async () => {
      const tenant = await createTenant();
      const firstStore = newStore();
      const secondStore = newStore();
      firstStore.latencyMs = 3;
      secondStore.latencyMs = 3;
      const first = await start(tenant, firstStore);
      const second = await start(tenant, secondStore);
      // Reopen the retired context, as if both had been created at once.
      await client`UPDATE woocommerce_pending_installs SET superseded_at = NULL WHERE org_id = ${tenant.orgId}`;

      const results = await Promise.all([
        callback(first, approve(firstStore)),
        callback(second, approve(secondStore)),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      const [connection] = await connectionsOf(tenant.orgId);
      const [winner, loser] =
        connection.store_url === firstStore.url
          ? [firstStore, secondStore]
          : [secondStore, firstStore];
      expect(akeedWebhooks(winner)).toHaveLength(2);
      expect(akeedWebhooks(loser)).toHaveLength(0);
    });

    it('concurrent starts leave exactly one usable context', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const owner = member(tenant);

      await Promise.all([
        start(tenant, store, owner),
        start(tenant, store, owner),
      ]);

      const open = await client`
        SELECT id FROM woocommerce_pending_installs
        WHERE org_id = ${tenant.orgId} AND consumed_at IS NULL AND superseded_at IS NULL`;
      expect(open).toHaveLength(1);
    });

    it('a new install started while a callback holds the open context is retried past the deadlock', async () => {
      const tenant = await createTenant();
      const store = newStore();
      await start(tenant, store);
      let restarted: Promise<StartedInstall> | undefined;

      // The callback's lock order, by hand: the open context, then the
      // organization. The new install takes them the other way round.
      const callbackTx = await client.reserve();
      try {
        await callbackTx`BEGIN`;
        await callbackTx`
          SELECT id FROM woocommerce_pending_installs
          WHERE org_id = ${tenant.orgId} FOR UPDATE`;
        restarted = start(tenant, store);
        for (let waited = 0; waited < 50; waited++) {
          const [blocked] = await client<{ waiting: number }[]>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()`;
          if (blocked.waiting > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await callbackTx`
          SELECT id FROM organizations WHERE id = ${tenant.orgId} FOR UPDATE`;
        await callbackTx`COMMIT`;
      } finally {
        callbackTx.release();
      }

      await expect(restarted).resolves.toMatchObject({
        callbackToken: expect.any(String) as string,
      });
      const open = await client`
        SELECT id FROM woocommerce_pending_installs
        WHERE org_id = ${tenant.orgId} AND consumed_at IS NULL AND superseded_at IS NULL`;
      expect(open).toHaveLength(1);
    });

    it('rolls the whole provisioning back when a write fails, removes its webhooks, and the same link then succeeds', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const keys = approve(store);

      await client`UPDATE fault_switch SET fail = true`;
      try {
        await expect(
          service.handleCallback(
            started.callbackToken,
            callbackBody(started, keys),
          ),
        ).rejects.toThrow();
      } finally {
        await client`UPDATE fault_switch SET fail = false`;
      }
      await expectNothingProvisioned(tenant);
      expect(akeedWebhooks(store)).toHaveLength(0);
      const [pending] = await pendingOf(tenant.orgId);
      expect(pending).toMatchObject({
        consumed_at: null,
        // Released, so the retry does not have to wait for the claim to lapse.
        claimed_until: null,
      });

      await expect(callback(started, keys)).resolves.toEqual({ status: 200 });
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(1);
      expect(akeedWebhooks(store)).toHaveLength(2);
    });
  });

  describe('delivery URL before ingestion', () => {
    it('answers the ping the store sends while the callback is still creating the webhooks', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      const pings: { status: number; code?: string }[] = [];
      store.onPing = async (deliveryUrl) => {
        // No connection row exists yet at this point.
        await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(0);
        pings.push(await deliver(tokenOf(deliveryUrl)));
      };

      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 200,
      });

      expect(pings).toEqual([{ status: 200 }, { status: 200 }]);
    });

    it('answers a ping on a connected token and refuses order deliveries until ingestion exists', async () => {
      const { store } = await connect();
      const token = tokenOf(akeedWebhooks(store)[0].delivery_url);

      await expect(deliver(token)).resolves.toEqual({ status: 200 });
      await expect(deliver(token, 'action.woocommerce_ping')).resolves.toEqual({
        status: 200,
      });
      for (const topic of ['order.created', 'order.updated'])
        await expect(deliver(token, topic)).resolves.toEqual({
          status: 404,
          code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE',
        });
    });

    it.each([
      ['an unknown token', randomBytes(32).toString('base64url')],
      ['a malformed token', 'not-a-token'],
      ['an empty token', ''],
    ])('answers %s as not found, ping or not', async (_label, token) => {
      await expect(deliver(token)).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE',
      });
    });

    it('does not accept the callback token as a delivery token', async () => {
      const { started } = await connect();

      await expect(deliver(started.callbackToken)).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE',
      });
    });

    it('stops answering the token of an install that can no longer connect', async () => {
      const tenant = await createTenant();
      const store = newStore();
      const started = await start(tenant, store);
      // A refused callback that left one webhook behind at the store.
      store.failNext('create', 500, 1);
      store.failNext('delete', 500);
      await callback(started, approve(store));
      const token = tokenOf(akeedWebhooks(store)[0].delivery_url);

      await expect(deliver(token)).resolves.toEqual({ status: 200 });
      await client`UPDATE woocommerce_pending_installs SET expires_at = now() - interval '1 second' WHERE org_id = ${tenant.orgId}`;
      await expect(deliver(token)).resolves.toEqual({
        status: 404,
        code: 'WOOCOMMERCE_INGESTION_UNAVAILABLE',
      });
    });
  });

  describe('setup, health, re-enable, disconnect and reconnect (US-07-05)', () => {
    /** Keeps the answer for the secrets check, then hands it back. */
    async function answered<T>(promise: Promise<T>): Promise<T> {
      const result = await promise;
      responses.push(result);
      return result;
    }

    async function sourceOf(tenant: Tenant) {
      const [integration] = await integrationsOf(tenant.orgId);
      return { id: String(integration.id), orgId: tenant.orgId };
    }

    function webhookOf(store: FakeWooCommerceStore, topic: string) {
      return akeedWebhooks(store).find((webhook) => webhook.topic === topic)!;
    }

    function routesSince(store: FakeWooCommerceStore, from: number) {
      return fake
        .requestsTo(store)
        .slice(from)
        .map((request) => request.route);
    }

    /** As a deployment that takes orders has it; this suite's default is off. */
    async function withIngestion<T>(run: () => Promise<T>): Promise<T> {
      settings.ingestionEnabled = true;
      try {
        return await run();
      } finally {
        settings.ingestionEnabled = false;
      }
    }

    /** The same install flow a first connect uses. */
    async function reconnect(tenant: Tenant, store: FakeWooCommerceStore) {
      const started = await start(tenant, store);
      const keys = approve(store);
      return { started, keys, answer: await callback(started, keys) };
    }

    describe('setup', () => {
      it('describes the connected store from the row alone, and needs no currency or phone country', async () => {
        const { tenant, store } = await connect();
        const before = fake.requestsTo(store).length;

        const described = await contributor.describe(await sourceOf(tenant));

        expect(described).toEqual({
          connectionState: 'connected',
          disconnectedAt: null,
          store: { reference: store.url, verified: true },
          orderDefaults: { currency: null, phoneCountry: null },
          blockedReasons: [],
          credentials: { status: 'ok' },
          delivery: {
            secretsMissing: false,
            rejectedCount: 0,
            lastRejectedAt: null,
          },
        });
        // Setup and settings are read on every route: no store is called.
        expect(fake.requestsTo(store)).toHaveLength(before);
      });

      it('has nothing to say of another tenant’s source, and asks no store for it', async () => {
        const { tenant, store } = await connect();
        const other = await createTenant();
        const source = await sourceOf(tenant);
        const before = fake.requestsTo(store).length;

        await expect(
          contributor.describe({ id: source.id, orgId: other.orgId }),
        ).resolves.toBeNull();
        await expect(
          contributor.inspectWebhooks({ id: source.id, orgId: other.orgId }),
        ).resolves.toBeNull();
        expect(fake.requestsTo(store)).toHaveLength(before);
      });
    });

    describe('webhook state in health', () => {
      it('reads each webhook from the bound store when health is read, with two requests', async () => {
        const { tenant, store } = await connect();
        const before = fake.requestsTo(store).length;

        const read = await contributor.inspectWebhooks(await sourceOf(tenant));

        expect(read?.items).toEqual([
          { kind: 'order_created', state: 'active' },
          { kind: 'order_updated', state: 'active' },
        ]);
        expect(routesSince(store, before)).toEqual([
          'webhook_read',
          'webhook_read',
        ]);
        // Every request went to this store, authenticated with its own keys.
        for (const request of fake.requestsTo(store).slice(before))
          expect(request).toMatchObject({
            host: store.host,
            authenticated: true,
            answered: 200,
          });
      });

      it.each([
        ['disabled', ['webhook_disabled']],
        ['paused', []],
      ] as const)(
        'shows a webhook the store has as %s, and only a disabled one blocks setup',
        async (state, blockedReasons) => {
          const { tenant, store } = await connect();
          const source = await sourceOf(tenant);
          store.setWebhookStatus(webhookOf(store, 'order.updated').id, state);

          // Nothing polls: until the store is asked, the last state stands.
          await expect(contributor.describe(source)).resolves.toMatchObject({
            blockedReasons: [],
          });

          const read = await contributor.inspectWebhooks(source);

          expect(read?.items).toEqual([
            { kind: 'order_created', state: 'active' },
            { kind: 'order_updated', state },
          ]);
          await expect(contributor.describe(source)).resolves.toMatchObject({
            blockedReasons,
          });
          const [row] = await connectionsOf(tenant.orgId);
          expect(row).toMatchObject({
            order_created_webhook_state: 'active',
            order_updated_webhook_state: state,
          });
          expect((await status(tenant)).connection?.webhooks).toEqual(
            read?.items,
          );
        },
      );

      it('shows a webhook deleted at the store as missing', async () => {
        const { tenant, store } = await connect();
        const source = await sourceOf(tenant);
        store.removeWebhook(webhookOf(store, 'order.created').id);

        const read = await contributor.inspectWebhooks(source);

        expect(read?.items).toEqual([
          { kind: 'order_created', state: 'missing' },
          { kind: 'order_updated', state: 'active' },
        ]);
        // The fix is a reconnect, not something that blocks setup by itself.
        await expect(contributor.describe(source)).resolves.toMatchObject({
          blockedReasons: [],
        });
      });

      it('a key revoked in the store shows as rejected credentials on the next health read', async () => {
        const { tenant, store, keys } = await connect();
        const source = await sourceOf(tenant);
        store.revokeKey(keys.consumerKey);

        const read = await contributor.inspectWebhooks(source);

        expect(read?.items.map((item) => item.state)).toEqual([
          'unknown',
          'unknown',
        ]);
        await expect(contributor.describe(source)).resolves.toMatchObject({
          credentials: { status: 'rejected' },
          blockedReasons: ['credentials_rejected'],
        });
        expect((await connectionsOf(tenant.orgId))[0]).toMatchObject({
          health: 'credentials_rejected',
          // What was last read stands; the store said nothing new of them.
          order_created_webhook_state: 'active',
          order_updated_webhook_state: 'active',
        });
      });

      it('a key whose user lost the permission shows as rejected, and clears once it is back', async () => {
        const { tenant, store, keys } = await connect();
        const source = await sourceOf(tenant);
        store.setKeyCanManage(keys.consumerKey, false);

        await contributor.inspectWebhooks(source);
        expect((await status(tenant)).connection?.health).toBe(
          'permission_denied',
        );
        await expect(contributor.describe(source)).resolves.toMatchObject({
          blockedReasons: ['credentials_rejected'],
        });

        store.setKeyCanManage(keys.consumerKey, true);
        await contributor.inspectWebhooks(source);

        expect((await status(tenant)).connection?.health).toBe('ok');
        await expect(contributor.describe(source)).resolves.toMatchObject({
          credentials: { status: 'ok' },
          blockedReasons: [],
        });
      });

      it('a store that does not answer is unknown, not a fault of the keys or the webhooks', async () => {
        const { tenant, store } = await connect();
        const source = await sourceOf(tenant);
        store.down = true;

        const read = await contributor.inspectWebhooks(source);

        expect(read?.items.map((item) => item.state)).toEqual([
          'unknown',
          'unknown',
        ]);
        await expect(contributor.describe(source)).resolves.toMatchObject({
          credentials: { status: 'ok' },
          blockedReasons: [],
        });
      });

      it('never sends the keys to a store that now resolves to a private address', async () => {
        const { tenant, store } = await connect();
        store.addresses = ['10.0.0.8'];
        const before = fake.requestsTo(store).length;

        const read = await contributor.inspectWebhooks(await sourceOf(tenant));

        expect(read?.items.map((item) => item.state)).toEqual([
          'unknown',
          'unknown',
        ]);
        expect(fake.requestsTo(store)).toHaveLength(before);
      });
    });

    describe('connection check', () => {
      interface CheckCase {
        label: string;
        break: (store: FakeWooCommerceStore, keys: Keys) => void;
        problems: string[];
        /** Whether any request may reach the store at all. */
        reachesStore?: boolean;
      }
      const cases: CheckCase[] = [
        { label: 'a healthy store', break: () => undefined, problems: [] },
        {
          label: 'a REST API that is not there (plain permalinks)',
          break: (store) => {
            store.permalinks = false;
          },
          problems: ['WOOCOMMERCE_REST_NOT_FOUND'],
        },
        {
          label: 'a store that does not answer',
          break: (store) => {
            store.down = true;
          },
          problems: ['WOOCOMMERCE_REST_UNREACHABLE'],
        },
        {
          label: 'an invalid TLS certificate',
          break: (store) => {
            store.validCertificate = false;
          },
          problems: ['WOOCOMMERCE_STORE_TLS_FAILED'],
        },
        {
          label: 'an address that now redirects',
          break: (store) => {
            store.redirectTo = 'https://elsewhere.example.org/';
          },
          problems: ['WOOCOMMERCE_STORE_REDIRECTS'],
        },
        {
          label: 'an address that is no longer public',
          break: (store) => {
            store.addresses = ['169.254.169.254'];
          },
          problems: ['WOOCOMMERCE_STORE_ADDRESS_NOT_PUBLIC'],
          reachesStore: false,
        },
        {
          label: 'keys the store rejects',
          break: (store, keys) => store.revokeKey(keys.consumerKey),
          problems: ['WOOCOMMERCE_CREDENTIALS_REJECTED'],
        },
        {
          label: 'a user who may no longer manage WooCommerce',
          break: (store, keys) =>
            store.setKeyCanManage(keys.consumerKey, false),
          problems: ['WOOCOMMERCE_PERMISSION_DENIED'],
        },
        {
          label: 'a store that now calls itself by another address',
          break: (store) => {
            store.homeUrl = 'https://renamed-store.example.org';
          },
          problems: ['WOOCOMMERCE_STORE_URL_MISMATCH'],
        },
        {
          label: 'a disabled webhook',
          break: (store) =>
            store.setWebhookStatus(akeedWebhooks(store)[0].id, 'disabled'),
          problems: ['WOOCOMMERCE_WEBHOOK_DISABLED'],
        },
        {
          label: 'a webhook deleted at the store',
          break: (store) => store.removeWebhook(akeedWebhooks(store)[1].id),
          problems: ['WOOCOMMERCE_WEBHOOK_MISSING'],
        },
        {
          label: 'a paused webhook',
          break: (store) =>
            store.setWebhookStatus(akeedWebhooks(store)[0].id, 'paused'),
          problems: ['WOOCOMMERCE_WEBHOOK_PAUSED'],
        },
      ];

      it.each(cases)(
        'tells $label apart by its own code',
        async ({ break: breakStore, problems, reachesStore }) => {
          const { tenant, store, keys } = await connect();
          breakStore(store, keys);
          const before = fake.requestsTo(store).length;
          const elsewhere = fake.requests.length - before;

          const check = await answered(service.checkConnection(member(tenant)));

          expect(check.problems).toEqual(problems);
          expect(check.status).toMatchObject({
            state: 'connected',
            storeUrl: store.url,
          });
          if (reachesStore === false)
            expect(fake.requestsTo(store)).toHaveLength(before);
          // No request went anywhere but the bound store.
          expect(fake.requests.length - fake.requestsTo(store).length).toBe(
            elsewhere,
          );
          expect(JSON.stringify(check)).not.toContain('renamed-store');
        },
      );

      it('runs with the connect switch off and off the pilot list', async () => {
        const { tenant } = await connect();
        settings.enabled = false;
        const listed = settings.pilotOrgIds.splice(0);
        try {
          await expect(
            answered(service.checkConnection(member(tenant))),
          ).resolves.toMatchObject({ problems: [] });
        } finally {
          settings.enabled = true;
          settings.pilotOrgIds.push(...listed);
        }
      });

      it('refuses a viewer, and an organization with no connection', async () => {
        const { tenant, store } = await connect();
        const before = fake.requestsTo(store).length;

        await expect(
          outcome(service.checkConnection(member(tenant, 'viewer'))),
        ).resolves.toEqual({ status: 403, code: 'WOOCOMMERCE_ROLE_REQUIRED' });
        await expect(
          outcome(service.checkConnection(member(await createTenant()))),
        ).resolves.toEqual({ status: 404, code: 'WOOCOMMERCE_NOT_CONNECTED' });
        expect(fake.requestsTo(store)).toHaveLength(before);
      });
    });

    describe('re-enabling a disabled webhook', () => {
      it('sets it active again at the store, confirms by reading, and answers the ping', async () => {
        const { tenant, store } = await connect();
        const disabled = webhookOf(store, 'order.updated');
        store.setWebhookStatus(disabled.id, 'disabled');
        await contributor.inspectWebhooks(await sourceOf(tenant));
        const pings: { status: number; code?: string }[] = [];
        store.onPing = async (deliveryUrl) => {
          pings.push(await deliver(tokenOf(deliveryUrl)));
        };
        const before = fake.requestsTo(store).length;

        const result = await withIngestion(() =>
          answered(service.enableWebhooks(member(tenant, 'admin'))),
        );

        expect(result.connection?.webhooks).toEqual([
          { kind: 'order_created', state: 'active' },
          { kind: 'order_updated', state: 'active' },
        ]);
        expect(store.webhooks.get(disabled.id)?.status).toBe('active');
        expect(routesSince(store, before)).toEqual([
          'webhook_read',
          'webhook_read',
          'webhook_write',
          'webhook_read',
          'webhook_read',
        ]);
        // A ping after re-enabling is answered 2xx: one failure could
        // disable the webhook again (finding 3.17).
        expect(pings).toEqual([{ status: 200 }]);
        await expect(
          contributor.describe(await sourceOf(tenant)),
        ).resolves.toMatchObject({ blockedReasons: [] });
        // Same webhooks, same address: nothing was created or replaced.
        expect(akeedWebhooks(store)).toHaveLength(2);
      });

      it('refuses while ingestion is off, without calling the store', async () => {
        const { tenant, store } = await connect();
        const disabled = webhookOf(store, 'order.created');
        store.setWebhookStatus(disabled.id, 'disabled');
        const before = fake.requestsTo(store).length;

        await expect(
          outcome(service.enableWebhooks(member(tenant))),
        ).resolves.toEqual({
          status: 503,
          code: 'WOOCOMMERCE_WEBHOOK_ENABLE_UNAVAILABLE',
        });
        expect(fake.requestsTo(store)).toHaveLength(before);
        expect(store.webhooks.get(disabled.id)?.status).toBe('disabled');
      });

      it('needs neither the connect switch nor the pilot list', async () => {
        const { tenant, store } = await connect();
        store.setWebhookStatus(akeedWebhooks(store)[0].id, 'disabled');
        settings.enabled = false;
        const listed = settings.pilotOrgIds.splice(0);
        try {
          const result = await withIngestion(() =>
            answered(service.enableWebhooks(member(tenant))),
          );
          expect(
            result.connection?.webhooks.map((webhook) => webhook.state),
          ).toEqual(['active', 'active']);
        } finally {
          settings.enabled = true;
          settings.pilotOrgIds.push(...listed);
        }
      });

      it('cannot bring back a webhook that was deleted at the store, and changes the other one not at all', async () => {
        const { tenant, store } = await connect();
        store.removeWebhook(webhookOf(store, 'order.created').id);
        const other = webhookOf(store, 'order.updated');
        store.setWebhookStatus(other.id, 'disabled');

        await expect(
          withIngestion(() => outcome(service.enableWebhooks(member(tenant)))),
        ).resolves.toEqual({
          status: 409,
          code: 'WOOCOMMERCE_WEBHOOK_MISSING',
        });
        expect(store.webhooks.get(other.id)?.status).toBe('disabled');
        expect(akeedWebhooks(store)).toHaveLength(1);
      });

      it('does not report success for a webhook the store still shows as disabled', async () => {
        const { tenant, store } = await connect();
        store.setWebhookStatus(akeedWebhooks(store)[0].id, 'disabled');
        store.ignoreWebhookStatusChange = true;

        await expect(
          withIngestion(() => outcome(service.enableWebhooks(member(tenant)))),
        ).resolves.toEqual({
          status: 503,
          code: 'WOOCOMMERCE_WEBHOOK_ENABLE_FAILED',
        });
        await expect(
          contributor.describe(await sourceOf(tenant)),
        ).resolves.toMatchObject({ blockedReasons: ['webhook_disabled'] });
      });

      it('leaves a webhook the merchant paused as it is', async () => {
        const { tenant, store } = await connect();
        const paused = akeedWebhooks(store)[0];
        store.setWebhookStatus(paused.id, 'paused');
        const before = fake.requestsTo(store).length;

        await withIngestion(() =>
          answered(service.enableWebhooks(member(tenant))),
        );

        expect(store.webhooks.get(paused.id)?.status).toBe('paused');
        expect(routesSince(store, before)).toEqual([
          'webhook_read',
          'webhook_read',
        ]);
      });

      it('refuses a viewer, and never touches another tenant’s store', async () => {
        const { tenant, store } = await connect();
        const disabled = akeedWebhooks(store)[0];
        store.setWebhookStatus(disabled.id, 'disabled');
        const before = fake.requestsTo(store).length;

        await withIngestion(async () => {
          await expect(
            outcome(service.enableWebhooks(member(tenant, 'viewer'))),
          ).resolves.toEqual({
            status: 403,
            code: 'WOOCOMMERCE_ROLE_REQUIRED',
          });
          // Another organization's owner acts on their own source: none.
          await expect(
            outcome(service.enableWebhooks(member(await createTenant()))),
          ).resolves.toEqual({
            status: 404,
            code: 'WOOCOMMERCE_NOT_CONNECTED',
          });
        });
        expect(fake.requestsTo(store)).toHaveLength(before);
        expect(store.webhooks.get(disabled.id)?.status).toBe('disabled');
      });
    });

    describe('disconnect', () => {
      it('stops the source, deletes Akeed’s webhooks at the store and wipes every credential, keeping the store and the integration', async () => {
        const { tenant, store } = await connect();
        const foreign = store.addForeignWebhook('https://other.example/hook');
        const [integration] = await integrationsOf(tenant.orgId);
        const [connected] = await connectionsOf(tenant.orgId);
        const user = member(tenant);
        const before = fake.requestsTo(store).length;

        const result = await answered(service.disconnect(user));

        expect(result).toEqual({
          state: 'disconnected',
          canManage: true,
          organizationName: tenant.name,
          storeUrl: store.url,
          expiresAt: null,
          lastErrorCode: null,
          webhookCleanup: 'removed',
          connection: {
            storeUrl: store.url,
            health: 'ok',
            connectedAt: expect.any(String) as string,
            rejectedDeliveries: 0,
            webhooks: [],
            webhooksCheckedAt: expect.any(String) as string,
            disconnectedAt: expect.any(String) as string,
          },
        });
        // Exactly the two deletions, at the bound store, and nothing else.
        expect(routesSince(store, before)).toEqual(['delete', 'delete']);
        expect(akeedWebhooks(store)).toHaveLength(0);
        expect(store.webhooks.has(foreign)).toBe(true);

        const [source] = await integrationsOf(tenant.orgId);
        expect(source).toMatchObject({
          id: integration.id,
          is_active: false,
          platform_type: 'woocommerce',
          platform_store_url: `woocommerce:${tenant.orgId}`,
          onboarding_status: integration.onboarding_status,
          billing_plan_id: 'starter',
        });
        const [row] = await connectionsOf(tenant.orgId);
        expect(row).toMatchObject({
          integration_id: connected.integration_id,
          store_url: store.url,
          store_verified_at: null,
          consumer_key_encrypted: null,
          consumer_secret_encrypted: null,
          webhook_secret_encrypted: null,
          webhook_token_hash: null,
          order_created_webhook_id: null,
          order_updated_webhook_id: null,
          order_created_webhook_state: null,
          order_updated_webhook_state: null,
          disconnected_by: user.userId,
        });
        expect(row.disconnected_at).not.toBeNull();
        expect(closedSyncs).toContainEqual({
          orgId: tenant.orgId,
          integrationId: connected.integration_id,
          reason: 'integration_inactive',
        });
      });

      it('a second disconnect changes nothing and calls no store', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        const [row] = await connectionsOf(tenant.orgId);
        const before = fake.requestsTo(store).length;

        await expect(
          answered(service.disconnect(member(tenant))),
        ).resolves.toMatchObject({
          state: 'disconnected',
          webhookCleanup: 'not_attempted',
        });

        expect(fake.requestsTo(store)).toHaveLength(before);
        await expect(connectionsOf(tenant.orgId)).resolves.toEqual([row]);
      });

      it.each([
        [
          'the store refuses the deletion',
          (store: FakeWooCommerceStore) => store.failNext('delete', 500),
        ],
        [
          'the store does not answer',
          (store: FakeWooCommerceStore) => {
            store.down = true;
          },
        ],
        [
          'the keys were revoked in the store',
          (store: FakeWooCommerceStore, keys: Keys) =>
            store.revokeKey(keys.consumerKey),
        ],
      ] as const)(
        'still disconnects and says the webhooks are left when %s',
        async (_label, breakStore) => {
          const { tenant, store, keys } = await connect();
          const oldToken = tokenOf(akeedWebhooks(store)[0].delivery_url);
          breakStore(store, keys);

          const result = await answered(service.disconnect(member(tenant)));

          expect(result).toMatchObject({
            state: 'disconnected',
            webhookCleanup: 'failed',
          });
          const [row] = await connectionsOf(tenant.orgId);
          expect(row).toMatchObject({
            consumer_key_encrypted: null,
            webhook_token_hash: null,
          });
          expect(row.disconnected_at).not.toBeNull();
          expect((await integrationsOf(tenant.orgId))[0].is_active).toBe(false);
          // A webhook left behind reaches an address Akeed no longer honours,
          // so the store disables it by itself (contract record section 3).
          expect(akeedWebhooks(store).length).toBeGreaterThan(0);
          await withIngestion(async () => {
            for (const topic of [undefined, 'order.created', 'order.updated'])
              await expect(deliver(oldToken, topic)).resolves.toEqual({
                status: 401,
                code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
              });
          });
        },
      );

      it('is not gated by the connect switch or the pilot list, and stays readable', async () => {
        const { tenant } = await connect();
        settings.enabled = false;
        const listed = settings.pilotOrgIds.splice(0);
        try {
          await expect(
            answered(service.disconnect(member(tenant))),
          ).resolves.toMatchObject({ state: 'disconnected' });
          await expect(
            status(tenant, member(tenant, 'viewer')),
          ).resolves.toMatchObject({
            state: 'disconnected',
            canManage: false,
            connection: { webhooks: [] },
          });
        } finally {
          settings.enabled = true;
          settings.pilotOrgIds.push(...listed);
        }
      });

      it('refuses a viewer’s disconnect and reconnect', async () => {
        const { tenant, store } = await connect();
        const viewer = member(tenant, 'viewer');

        await expect(outcome(service.disconnect(viewer))).resolves.toEqual({
          status: 403,
          code: 'WOOCOMMERCE_ROLE_REQUIRED',
        });
        expect((await integrationsOf(tenant.orgId))[0].is_active).toBe(true);
        expect(akeedWebhooks(store)).toHaveLength(2);

        await answered(service.disconnect(member(tenant)));
        await expect(
          outcome(
            service.startInstall(viewer, { storeUrl: store.url, locale: 'ar' }),
          ),
        ).resolves.toEqual({ status: 403, code: 'WOOCOMMERCE_ROLE_REQUIRED' });
      });

      it('answers an organization with no connection as not connected', async () => {
        await expect(
          outcome(service.disconnect(member(await createTenant()))),
        ).resolves.toEqual({ status: 404, code: 'WOOCOMMERCE_NOT_CONNECTED' });
      });

      it('another tenant cannot disconnect this connection', async () => {
        const { tenant, store } = await connect();
        const [row] = await connectionsOf(tenant.orgId);
        const before = fake.requestsTo(store).length;

        await expect(
          outcome(service.disconnect(member(await createTenant()))),
        ).resolves.toEqual({ status: 404, code: 'WOOCOMMERCE_NOT_CONNECTED' });

        await expect(connectionsOf(tenant.orgId)).resolves.toEqual([row]);
        expect(akeedWebhooks(store)).toHaveLength(2);
        expect(fake.requestsTo(store)).toHaveLength(before);
      });

      it('keeps setup and health readable afterwards, and asks the store nothing', async () => {
        const { tenant, store } = await connect();
        const source = await sourceOf(tenant);
        await answered(service.disconnect(member(tenant)));
        const before = fake.requestsTo(store).length;

        await expect(contributor.describe(source)).resolves.toMatchObject({
          connectionState: 'disconnected',
          store: { reference: store.url, verified: false },
          credentials: { status: 'removed' },
          blockedReasons: ['source_disconnected'],
        });
        await expect(contributor.inspectWebhooks(source)).resolves.toBeNull();
        await expect(
          outcome(service.checkConnection(member(tenant))),
        ).resolves.toEqual({ status: 404, code: 'WOOCOMMERCE_NOT_CONNECTED' });
        expect(fake.requestsTo(store)).toHaveLength(before);
      });

      it('a disconnected row can hold no credential and no verified slot, and a connected one cannot lose any', async () => {
        const live = await connect();
        const gone = await connect();
        await answered(service.disconnect(member(gone.tenant)));

        for (const change of [
          "consumer_key_encrypted = 'v1:left-behind'",
          "webhook_token_hash = repeat('a', 64)",
          'order_created_webhook_id = 7',
          'store_verified_at = now()',
        ])
          await expect(
            client.unsafe(
              `UPDATE woocommerce_connections SET ${change} WHERE org_id = '${gone.tenant.orgId}'`,
            ),
          ).rejects.toThrow(/credentials_state_check/);
        for (const column of [
          'consumer_secret_encrypted',
          'webhook_secret_encrypted',
          'order_updated_webhook_id',
        ])
          await expect(
            client.unsafe(
              `UPDATE woocommerce_connections SET ${column} = NULL WHERE org_id = '${live.tenant.orgId}'`,
            ),
          ).rejects.toThrow(/credentials_state_check/);
        await expect(
          client.unsafe(
            `UPDATE woocommerce_connections SET order_created_webhook_state = 'enabled' WHERE org_id = '${live.tenant.orgId}'`,
          ),
        ).rejects.toThrow(/webhook_state_check/);
      });
    });

    describe('reconnect', () => {
      it('brings the same store back in place, with new keys, a new delivery address and its webhooks replaced', async () => {
        const first = await connect();
        const { tenant, store } = first;
        const [integration] = await integrationsOf(tenant.orgId);
        const [before] = await connectionsOf(tenant.orgId);
        const oldToken = tokenOf(akeedWebhooks(store)[0].delivery_url);
        const oldIds = akeedWebhooks(store).map((webhook) => webhook.id);
        // The store kept the old webhooks: the deletion at disconnect failed.
        store.failNext('delete', 500);
        store.failNext('delete', 500);
        await expect(
          answered(service.disconnect(member(tenant))),
        ).resolves.toMatchObject({ webhookCleanup: 'failed' });
        expect(akeedWebhooks(store)).toHaveLength(2);
        await client`UPDATE integrations SET onboarding_status = 'completed' WHERE org_id = ${tenant.orgId}`;

        const second = await reconnect(tenant, store);

        expect(second.answer).toEqual({ status: 200 });
        // The same source: its orders and history stay attached.
        const sources = await integrationsOf(tenant.orgId);
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({
          id: integration.id,
          is_active: true,
          onboarding_status: 'completed',
        });
        const rows = await connectionsOf(tenant.orgId);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
          integration_id: before.integration_id,
          store_url: store.url,
          health: 'ok',
          rejected_deliveries: 0,
          disconnected_at: null,
          disconnected_by: null,
          order_created_webhook_state: 'active',
          order_updated_webhook_state: 'active',
        });
        expect(row.store_verified_at).not.toBeNull();
        // An order placed while disconnected is older than this moment.
        expect(new Date(row.connected_at).getTime()).toBeGreaterThan(
          new Date(before.connected_at).getTime(),
        );
        expect(decryptToken(row.consumer_key_encrypted, ENCRYPTION_KEY)).toBe(
          second.keys.consumerKey,
        );
        expect(
          decryptToken(row.consumer_secret_encrypted, ENCRYPTION_KEY),
        ).toBe(second.keys.consumerSecret);
        expect(row.consumer_key_encrypted).not.toBe(
          before.consumer_key_encrypted,
        );
        expect(row.webhook_secret_encrypted).not.toBe(
          before.webhook_secret_encrypted,
        );
        expect(row.webhook_token_hash).not.toBe(before.webhook_token_hash);

        // Replaced, never added to: exactly two, neither of them an old one.
        const current = akeedWebhooks(store);
        expect(current.map((webhook) => webhook.topic).sort()).toEqual([
          'order.created',
          'order.updated',
        ]);
        for (const webhook of current) expect(oldIds).not.toContain(webhook.id);
        expect(Number(row.order_created_webhook_id)).toBe(
          webhookOf(store, 'order.created').id,
        );
        const newToken = tokenOf(current[0].delivery_url);
        expect(sha256(newToken)).toBe(row.webhook_token_hash);
        expect(newToken).not.toBe(oldToken);

        await withIngestion(async () => {
          await expect(deliver(newToken)).resolves.toEqual({ status: 200 });
          await expect(deliver(oldToken)).resolves.toEqual({
            status: 401,
            code: 'WOOCOMMERCE_WEBHOOK_UNAUTHORIZED',
          });
        });
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'connected',
          storeUrl: store.url,
          connection: { disconnectedAt: null, health: 'ok' },
        });
        await expect(
          contributor.describe(await sourceOf(tenant)),
        ).resolves.toMatchObject({
          connectionState: 'connected',
          store: { verified: true },
          blockedReasons: [],
        });
      });

      it.each([
        ['a different store', () => newStore().url],
        [
          'the same host under another path',
          (store: FakeWooCommerceStore) => `${store.url}/other-shop`,
        ],
        [
          'the www form of the same host',
          (store: FakeWooCommerceStore) =>
            store.url.replace('https://', 'https://www.'),
        ],
      ] as const)(
        'refuses %s at the start, without calling it',
        async (_label, otherUrl) => {
          const { tenant, store } = await connect();
          await answered(service.disconnect(member(tenant)));
          const [row] = await connectionsOf(tenant.orgId);
          const requestsBefore = fake.requests.length;

          await expect(
            outcome(
              service.startInstall(member(tenant), {
                storeUrl: otherUrl(store),
                locale: 'ar',
              }),
            ),
          ).resolves.toEqual({
            status: 409,
            code: 'WOOCOMMERCE_RECONNECT_STORE_MISMATCH',
          });

          // A disconnected organization cannot make Akeed call another host.
          expect(fake.requests).toHaveLength(requestsBefore);
          await expect(connectionsOf(tenant.orgId)).resolves.toEqual([row]);
          await expect(status(tenant)).resolves.toMatchObject({
            state: 'disconnected',
          });
          await expect(pendingOf(tenant.orgId)).resolves.toHaveLength(1);
        },
      );

      it('refuses a callback whose install names another store, and leaves nothing at that store', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        const other = newStore();
        const started = await start(tenant, store);
        // An install row that names another store, however it came to.
        await client`
          UPDATE woocommerce_pending_installs SET store_url = ${other.url}
          WHERE org_id = ${tenant.orgId} AND consumed_at IS NULL AND superseded_at IS NULL`;
        const [row] = await connectionsOf(tenant.orgId);

        await expect(callback(started, approve(other))).resolves.toEqual({
          status: 409,
          code: 'WOOCOMMERCE_RECONNECT_STORE_MISMATCH',
        });

        await expect(connectionsOf(tenant.orgId)).resolves.toEqual([row]);
        expect((await integrationsOf(tenant.orgId))[0].is_active).toBe(false);
        expect(akeedWebhooks(other)).toHaveLength(0);
      });

      it('refuses a reconnect when another organization has verified the store since, and leaves that connection and its webhooks untouched', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        // The disconnect released the store, so another organization took it.
        const taker = await createTenant();
        await expect(
          callback(await start(taker, store), approve(store)),
        ).resolves.toEqual({ status: 200 });
        const takerWebhooks = akeedWebhooks(store).map((webhook) => webhook.id);
        const [takerRow] = await connectionsOf(taker.orgId);

        const started = await start(tenant, store);
        const before = fake.requestsTo(store).length;
        await expect(callback(started, approve(store))).resolves.toEqual({
          status: 409,
          code: 'WOOCOMMERCE_STORE_UNAVAILABLE',
        });

        // Refused before any request: the webhooks there are the other's.
        expect(fake.requestsTo(store)).toHaveLength(before);
        expect(akeedWebhooks(store).map((webhook) => webhook.id)).toEqual(
          takerWebhooks,
        );
        await expect(connectionsOf(taker.orgId)).resolves.toEqual([takerRow]);
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'failed',
          lastErrorCode: 'WOOCOMMERCE_STORE_UNAVAILABLE',
          connection: { storeUrl: store.url },
        });
        expect((await integrationsOf(tenant.orgId))[0].is_active).toBe(false);
      });

      it('another tenant cannot reconnect into this organization’s disconnected source', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        const [row] = await connectionsOf(tenant.orgId);
        const [integration] = await integrationsOf(tenant.orgId);
        const stranger = await createTenant();

        // The stranger connects the store as a new source of their own.
        await expect(
          callback(await start(stranger, store), approve(store)),
        ).resolves.toEqual({ status: 200 });

        await expect(connectionsOf(tenant.orgId)).resolves.toEqual([row]);
        await expect(integrationsOf(tenant.orgId)).resolves.toEqual([
          integration,
        ]);
        const [theirs] = await integrationsOf(stranger.orgId);
        expect(theirs.id).not.toBe(integration.id);
      });

      it('a refused reconnect leaves the source disconnected and unchanged, and the next attempt connects', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        const [row] = await connectionsOf(tenant.orgId);
        const started = await start(tenant, store);
        const rejected = approve(store);
        store.revokeKey(rejected.consumerKey);

        await expect(callback(started, rejected)).resolves.toEqual({
          status: 422,
          code: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
        });

        await expect(connectionsOf(tenant.orgId)).resolves.toEqual([row]);
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'failed',
          lastErrorCode: 'WOOCOMMERCE_CREDENTIALS_REJECTED',
          connection: { storeUrl: store.url },
        });
        expect(akeedWebhooks(store)).toHaveLength(0);

        // The same link, with keys the store accepts.
        await expect(callback(started, approve(store))).resolves.toEqual({
          status: 200,
        });
        expect((await integrationsOf(tenant.orgId))[0].is_active).toBe(true);
        expect(akeedWebhooks(store)).toHaveLength(2);
      });

      it('keys the store rejects are recovered by disconnect then reconnect, on the same source', async () => {
        const { tenant, store, keys } = await connect();
        const source = await sourceOf(tenant);
        store.revokeKey(keys.consumerKey);
        await expect(
          answered(service.checkConnection(member(tenant))),
        ).resolves.toMatchObject({
          problems: ['WOOCOMMERCE_CREDENTIALS_REJECTED'],
        });
        await expect(contributor.describe(source)).resolves.toMatchObject({
          blockedReasons: ['credentials_rejected'],
        });

        // The rejected keys cannot delete the webhooks: they are left.
        await expect(
          answered(service.disconnect(member(tenant))),
        ).resolves.toMatchObject({ webhookCleanup: 'failed' });
        const { answer } = await reconnect(tenant, store);

        expect(answer).toEqual({ status: 200 });
        expect((await sourceOf(tenant)).id).toBe(source.id);
        expect(akeedWebhooks(store)).toHaveLength(2);
        await expect(contributor.describe(source)).resolves.toMatchObject({
          credentials: { status: 'ok' },
          blockedReasons: [],
        });
      });

      it('a webhook deleted at the store is recovered the same way, with no duplicate', async () => {
        const { tenant, store } = await connect();
        store.removeWebhook(webhookOf(store, 'order.created').id);

        await expect(
          answered(service.disconnect(member(tenant))),
        ).resolves.toMatchObject({ webhookCleanup: 'removed' });
        expect(akeedWebhooks(store)).toHaveLength(0);
        const { answer } = await reconnect(tenant, store);

        expect(answer).toEqual({ status: 200 });
        expect(
          akeedWebhooks(store)
            .map((webhook) => webhook.topic)
            .sort(),
        ).toEqual(['order.created', 'order.updated']);
      });

      it('needs the connect switch and the pilot list, unlike the disconnect', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        const input = { storeUrl: store.url, locale: 'en' as const };

        settings.enabled = false;
        try {
          await expect(
            outcome(service.startInstall(member(tenant), input)),
          ).resolves.toEqual({
            status: 404,
            code: 'WOOCOMMERCE_CONNECT_UNAVAILABLE',
          });
        } finally {
          settings.enabled = true;
        }
        // A list that names another organization and not this one: an empty
        // list would allow every organization.
        const listed = settings.pilotOrgIds.splice(0);
        settings.pilotOrgIds.push(randomUUID());
        try {
          await expect(
            outcome(service.startInstall(member(tenant), input)),
          ).resolves.toEqual({
            status: 403,
            code: 'WOOCOMMERCE_PILOT_REQUIRED',
          });
        } finally {
          settings.pilotOrgIds.splice(0);
          settings.pilotOrgIds.push(...listed);
        }
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'disconnected',
        });
      });

      it('a disconnect retires a reconnect link opened before it', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        const started = await start(tenant, store);
        await answered(service.disconnect(member(tenant)));

        await expect(callback(started, approve(store))).resolves.toEqual({
          status: 401,
          code: 'WOOCOMMERCE_INSTALL_CONTEXT_INVALID',
        });
        expect((await integrationsOf(tenant.orgId))[0].is_active).toBe(false);
        expect(akeedWebhooks(store)).toHaveLength(0);
      });

      it('does not let a merchant reconnect a source that was switched off without a disconnect', async () => {
        const { tenant, store } = await connect();
        await client`UPDATE integrations SET is_active = false WHERE org_id = ${tenant.orgId}`;
        const before = fake.requestsTo(store).length;

        await expect(
          outcome(
            service.startInstall(member(tenant), {
              storeUrl: store.url,
              locale: 'ar',
            }),
          ),
        ).resolves.toEqual({ status: 409, code: 'WOOCOMMERCE_SOURCE_EXISTS' });
        expect(fake.requestsTo(store)).toHaveLength(before);
      });

      it('two reconnect callbacks at once bring the source back once, with exactly its two webhooks', async () => {
        const { tenant, store } = await connect();
        await answered(service.disconnect(member(tenant)));
        const started = await start(tenant, store);
        const keys = approve(store);
        store.latencyMs = 15;

        const answers = await Promise.all([
          callback(started, keys),
          callback(started, keys),
        ]);
        store.latencyMs = 0;

        expect(answers.map((answer) => answer.status).sort()).toEqual([
          200, 401,
        ]);
        await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
        await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(1);
        expect(akeedWebhooks(store)).toHaveLength(2);
      });
    });
  });

  describe('source-choosing signup', () => {
    const provisioning = new StandaloneOrganizationProvisioningRepository(
      database,
      standaloneCreditBillingConfigService(),
    );

    it('creates the organization and owner membership with no source, and connects without any conversion', async () => {
      const userId = randomUUID();

      const first = await provisioning.provisionWithoutSource(userId, 'Noor');
      const second = await provisioning.provisionWithoutSource(userId, 'Noor');

      expect(first.created).toBe(true);
      expect(second).toMatchObject({
        created: false,
        organization: { id: first.organization.id },
      });
      const tenant = { orgId: first.organization.id, name: 'Noor' };
      await expectNothingProvisioned(tenant);

      settings.pilotOrgIds.push(tenant.orgId);
      const store = newStore();
      const started = await start(tenant, store, {
        userId,
        orgId: tenant.orgId,
        role: 'owner',
        source: 'supabase',
      });
      await expect(callback(started, approve(store))).resolves.toEqual({
        status: 200,
      });
      const sources = await integrationsOf(tenant.orgId);
      expect(sources.map((source) => source.platform_type)).toEqual([
        'woocommerce',
      ]);
    });
  });

  describe('secrets and grants', () => {
    it('never puts a key, secret or token in a response, a log line or a stored column', async () => {
      // Every delivery token and webhook secret any store was ever given.
      for (const store of stores)
        for (const webhook of store.everCreated) {
          if (!webhook.delivery_url.startsWith(DELIVERY_BASE)) continue;
          secrets.add(webhook.secret);
          secrets.add(tokenOf(webhook.delivery_url));
        }
      secrets.delete('stale-token');
      expect(secrets.size).toBeGreaterThan(100);
      const returned = JSON.stringify(responses);
      const logged = logs.join('\n');
      const stored = JSON.stringify([
        await client`SELECT * FROM woocommerce_connections`,
        await client`SELECT * FROM woocommerce_pending_installs`,
        await client`SELECT * FROM integrations`,
      ]);
      expect(logs.length).toBeGreaterThan(50);
      expect(responses.length).toBeGreaterThan(50);

      for (const secret of secrets) {
        expect(returned.includes(secret)).toBe(false);
        expect(logged.includes(secret)).toBe(false);
        expect(stored.includes(secret)).toBe(false);
      }
    });

    it('logs the host of a store and never its path', async () => {
      const { store } = await connect('/private-shop-path');

      const mentioning = logs.filter((line) => line.includes(store.host));
      expect(mentioning.length).toBeGreaterThan(0);
      expect(logs.join('\n')).not.toContain('private-shop-path');
    });

    it('refuses plaintext in the credential columns', async () => {
      const { tenant } = await connect();

      for (const column of [
        'consumer_key_encrypted',
        'consumer_secret_encrypted',
        'webhook_secret_encrypted',
      ]) {
        await expect(
          client.unsafe(
            `UPDATE woocommerce_connections SET ${column} = 'plain' WHERE org_id = '${tenant.orgId}'`,
          ),
        ).rejects.toThrow(/_encrypted_check/);
      }
    });

    it.each(['authenticated', 'anon'])(
      'gives the %s role no access to either table',
      async (role) => {
        for (const table of [
          'woocommerce_connections',
          'woocommerce_pending_installs',
        ]) {
          await expect(
            client.begin(async (tx) => {
              await tx.unsafe(`SET LOCAL ROLE ${role}`);
              await tx.unsafe(`SELECT 1 FROM ${table} LIMIT 1`);
            }),
          ).rejects.toThrow(/permission denied/);
        }
      },
    );
  });
});
