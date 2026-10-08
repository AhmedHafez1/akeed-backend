import { HttpException, Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import type { CommerceOutcomeSyncsRepository } from '../src/infrastructure/database/repositories/commerce-outcome-syncs.repository';
import { EasyOrdersConnectionsRepository } from '../src/infrastructure/database/repositories/easyorders-connections.repository';
import { StandaloneOrganizationProvisioningRepository } from '../src/infrastructure/database/repositories/standalone-organization-provisioning.repository';
import {
  EASYORDERS_INACTIVE_STORE_MESSAGE,
  EasyOrdersApiClient,
  type EasyOrdersHttp,
} from '../src/infrastructure/spokes/easyorders/easyorders-api.client';
import { EasyOrdersAuthService } from '../src/infrastructure/spokes/easyorders/easyorders-auth.service';
import type { AuthenticatedUser } from '../src/modules/auth/guards/dual-auth.guard';
import {
  EASYORDERS_CONFIG,
  type EasyOrdersConfig,
} from '../src/shared/config/easyorders.config';
import { hashInstallToken } from '../src/shared/commerce/install-token';
import { PhoneService } from '../src/shared/services/phone.service';
import { decryptToken } from '../src/shared/utils/token-encryption.util';
import { standaloneCreditBillingConfigService } from './contracts/standalone-credit-billing-config';

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

const namespace = `e06_easyorders_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 12,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const repository = new EasyOrdersConnectionsRepository(
  database,
  standaloneCreditBillingConfigService(),
);
let created = false;

/** Synthetic, generated per run: never a real key. */
const ENCRYPTION_KEY = randomBytes(32).toString('hex');

const settings: EasyOrdersConfig & { pilotOrgIds: string[] } = {
  enabled: true,
  ingestionEnabled: false,
  outcomeSyncEnabled: false,
  pilotOrgIds: [],
  publicApiBaseUrl: 'https://api.akeed.test',
  appBaseUrl: 'https://app.akeed.test',
};

const config = {
  get: (key: string) => (key === EASYORDERS_CONFIG ? settings : undefined),
  getOrThrow: (key: string) => {
    if (key === 'SHOPIFY_TOKEN_ENCRYPTION_KEY') return ENCRYPTION_KEY;
    throw new Error(`Unexpected configuration key ${key}`);
  },
} as unknown as ConfigService;

/** What the fake EasyOrders API answers a key with, by key. */
type ProviderAnswer =
  | 'live'
  | 'inactive'
  | 'unauthorized'
  | 'not_found'
  | 'down';
const providerAnswers = new Map<string, ProviderAnswer>();
const probedKeys: string[] = [];
/** The addresses Akeed asked EasyOrders to delete a webhook for, in order. */
const webhookDeletes: string[] = [];

const fakeEasyOrders: EasyOrdersHttp = (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const key = new Headers(init?.headers).get('Api-Key') ?? '';
  // The client only ever passes the URL as text.
  if (init?.method === 'DELETE')
    return fakeDeleteWebhook(typeof input === 'string' ? input : '', key);
  probedKeys.push(key);
  switch (providerAnswers.get(key) ?? 'unauthorized') {
    case 'live':
      return Promise.resolve(Response.json({ id: 'order' }));
    case 'inactive':
      return Promise.resolve(
        Response.json(
          { message: EASYORDERS_INACTIVE_STORE_MESSAGE },
          { status: 400 },
        ),
      );
    case 'not_found':
      return Promise.resolve(new Response('', { status: 404 }));
    case 'down':
      return Promise.reject(new Error('socket hang up'));
    default:
      return Promise.resolve(new Response('', { status: 401 }));
  }
};

/** One registration per address: the first delete removes it, the next finds none. */
function fakeDeleteWebhook(url: string, key: string): Promise<Response> {
  const address = new URL(url).searchParams.get('url') ?? '';
  switch (providerAnswers.get(key) ?? 'unauthorized') {
    case 'live': {
      const repeated = webhookDeletes.includes(address);
      webhookDeletes.push(address);
      return Promise.resolve(
        new Response('', { status: repeated ? 404 : 200 }),
      );
    }
    case 'down':
      return Promise.reject(new Error('socket hang up'));
    default:
      return Promise.resolve(new Response('', { status: 401 }));
  }
}

const service = new EasyOrdersAuthService(
  repository,
  new EasyOrdersApiClient(fakeEasyOrders),
  config,
  new PhoneService(),
  // This suite's schema has no orders, so no outcome rows to close; the
  // outcome-sync contract covers that half of a disconnect.
  {
    failPendingForIntegration: () => Promise.resolve(0),
  } as unknown as CommerceOutcomeSyncsRepository,
);

/** Every value that must never be logged, returned or stored in clear. */
const secrets = new Set<string>();
const responses: unknown[] = [];
const logs: string[] = [];

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

function liveKey(answer: ProviderAnswer = 'live'): string {
  const key = `eo_${randomBytes(24).toString('base64url')}`;
  providerAnswers.set(key, answer);
  secrets.add(key);
  return key;
}

interface StartedInstall {
  callbackToken: string;
  webhookToken: string;
  expiresAt: string;
}

async function start(
  tenant: Tenant,
  user = member(tenant),
): Promise<StartedInstall> {
  const started = await service.startInstall(user, { locale: 'ar' });
  const params = new URLSearchParams(started.installUrl.split('?')[1]);
  const callbackToken = params.get('callback_url')!.split('/').pop()!;
  const webhookToken = params.get('orders_webhook')!.split('/').pop()!;
  secrets.add(callbackToken);
  secrets.add(webhookToken);
  return { callbackToken, webhookToken, expiresAt: started.expiresAt };
}

/** The status and code the service answers with, or 204. */
async function outcome(
  promise: Promise<unknown>,
): Promise<{ status: number; code?: string }> {
  try {
    responses.push(await promise);
    return { status: 204 };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as { code?: string };
    responses.push(body);
    return { status: error.getStatus(), code: body.code };
  }
}

function callback(token: string, apiKey: string, storeId: string) {
  return outcome(
    service.handleCallback(token, { api_key: apiKey, store_id: storeId }),
  );
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

/** The organization's credit account and its launch grants. */
async function launchGrantOf(orgId: string) {
  const [account] = await client<
    { status: string; posted_balance: number }[]
  >`SELECT status, posted_balance FROM credit_accounts WHERE org_id = ${orgId}`;
  const grants = await client<
    { quantity: number; actor_id: string }[]
  >`SELECT quantity, actor_id FROM credit_ledger_entries WHERE org_id = ${orgId} AND type = 'free_grant'`;
  return { account, grants };
}

function connectionsOf(orgId: string) {
  return client<
    {
      integration_id: string;
      store_id: string;
      store_verified_at: Date | null;
      api_key_encrypted: string | null;
      webhook_token_hash: string | null;
      webhook_token_hint: string | null;
      webhook_token_encrypted: string | null;
      provider_cleanup: string | null;
      orders_webhook_secret_encrypted: string | null;
      status_webhook_secret_encrypted: string | null;
      health: string;
      currency: string | null;
      phone_country: string | null;
      rejected_deliveries: number;
      disconnected_at: Date | null;
      disconnected_by: string | null;
    }[]
  >`SELECT * FROM easyorders_connections WHERE org_id = ${orgId}`;
}

async function expectNothingProvisioned(tenant: Tenant) {
  await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(0);
  await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(0);
}

describe('EasyOrders connection PostgreSQL contract (US-06-02, US-06-05)', () => {
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
      CREATE TABLE credit_accounts (
        org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'active',
        posted_balance integer NOT NULL DEFAULT 0,
        held_credits integer NOT NULL DEFAULT 0,
        version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE credit_ledger_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES credit_accounts(org_id) ON DELETE CASCADE,
        type text NOT NULL,
        quantity integer NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        reservation_id uuid,
        dispatch_id uuid,
        purchase_id uuid,
        source_ledger_entry_id uuid,
        source_reference text,
        actor_id uuid,
        reason text NOT NULL,
        posted_balance_before integer NOT NULL,
        posted_balance_after integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
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
        cod_template_ar_key text,
        cod_template_en_key text,
        cod_reminder_ar_key text,
        cod_reminder_en_key text,
        cod_template_ar_auto boolean DEFAULT false NOT NULL,
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
    // Applied twice: the migrations must be re-runnable. 0048 (US-06-03)
    // adds the columns the repository now selects; 0050 (US-06-05) makes the
    // credentials nullable for a disconnect.
    for (let pass = 0; pass < 2; pass++) {
      for (const migration of [
        '0047_easyorders_connection.sql',
        '0048_easyorders_ingestion.sql',
        '0050_easyorders_disconnect.sql',
        '0062_easyorders_webhook_cleanup.sql',
      ]) {
        for (const statement of readFileSync(
          resolve(__dirname, '../drizzle', migration),
          'utf8',
        ).split('--> statement-breakpoint')) {
          if (statement.trim()) await client.unsafe(statement);
        }
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
      CREATE TRIGGER easyorders_connections_fault BEFORE INSERT ON easyorders_connections
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
    it('provisions one easyorders source with the pilot entitlement, the onboarding defaults and encrypted credentials', async () => {
      const tenant = await createTenant();
      const owner = member(tenant);
      const key = liveKey();

      const started = await start(tenant, owner);
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'pending',
        expiresAt: started.expiresAt,
        connection: null,
      });

      await expect(
        callback(started.callbackToken, key, 'store-valid-1'),
      ).resolves.toEqual({ status: 204 });

      const sources = await integrationsOf(tenant.orgId);
      // Billed like Standalone: the account opens with the launch grant.
      await expect(launchGrantOf(tenant.orgId)).resolves.toEqual({
        account: { status: 'active', posted_balance: 30 },
        grants: [{ quantity: 30, actor_id: owner.userId }],
      });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        platform_type: 'easyorders',
        platform_store_url: `easyorders:${tenant.orgId}`,
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

      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection).toMatchObject({
        integration_id: sources[0].id,
        store_id: 'store-valid-1',
        store_verified_at: null,
        health: 'ok',
        orders_webhook_secret_encrypted: null,
        status_webhook_secret_encrypted: null,
        webhook_token_hint: started.webhookToken.slice(-6),
        provider_cleanup: null,
      });
      // Kept so a disconnect can name the two webhook addresses.
      expect(
        decryptToken(connection.webhook_token_encrypted!, ENCRYPTION_KEY),
      ).toBe(started.webhookToken);
      expect(connection.api_key_encrypted).toMatch(/^v1:/);
      expect(decryptToken(connection.api_key_encrypted!, ENCRYPTION_KEY)).toBe(
        key,
      );
      expect(connection.webhook_token_hash).toMatch(/^[0-9a-f]{64}$/);

      await expect(status(tenant)).resolves.toMatchObject({
        state: 'connected',
        connection: {
          storeId: 'store-valid-1',
          storeVerified: false,
          health: 'ok',
          webhookUrlHint: started.webhookToken.slice(-6),
          ordersSecretSet: false,
          statusSecretSet: false,
        },
      });
    });

    it('connects an inactive store as a health state, not a credential failure', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);

      await expect(
        callback(started.callbackToken, liveKey('inactive'), 'store-inactive'),
      ).resolves.toEqual({ status: 204 });

      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection.health).toBe('store_inactive');
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'connected',
        connection: { health: 'store_inactive' },
      });
    });

    it('lets an admin connect', async () => {
      const tenant = await createTenant();
      const started = await start(tenant, member(tenant, 'admin'));

      await expect(
        callback(started.callbackToken, liveKey(), 'store-admin'),
      ).resolves.toEqual({ status: 204 });
    });
  });

  describe('who may connect', () => {
    it('refuses a viewer, and a viewer cannot save webhook secrets', async () => {
      const tenant = await createTenant();
      const viewer = member(tenant, 'viewer');

      await expect(
        outcome(service.startInstall(viewer, { locale: 'en' })),
      ).resolves.toEqual({ status: 403, code: 'EASYORDERS_ROLE_REQUIRED' });
      await expect(
        outcome(
          service.saveWebhookSecrets(viewer, {
            ordersSecret: 'orders-secret-01',
            statusSecret: 'status-secret-01',
          }),
        ),
      ).resolves.toEqual({ status: 403, code: 'EASYORDERS_ROLE_REQUIRED' });
      await expect(status(tenant, viewer)).resolves.toMatchObject({
        state: 'ready',
        canManage: false,
      });
      const pending =
        await client`SELECT id FROM easyorders_pending_installs WHERE org_id = ${tenant.orgId}`;
      expect(pending).toHaveLength(0);
    });

    it('refuses an embedded Shopify session', async () => {
      const tenant = await createTenant();

      await expect(
        outcome(
          service.startInstall(member(tenant, 'owner', 'shopify'), {
            locale: 'en',
          }),
        ),
      ).resolves.toEqual({ status: 403, code: 'EASYORDERS_SESSION_REQUIRED' });
    });

    it('refuses an organization that is not on the pilot allow-list', async () => {
      const tenant = await createTenant({ pilot: false });

      await expect(
        outcome(service.startInstall(member(tenant), { locale: 'en' })),
      ).resolves.toEqual({ status: 403, code: 'EASYORDERS_PILOT_REQUIRED' });
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'pilot_required',
      });
    });

    it('refuses everything while the switch is off, including a callback on an open context', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      settings.enabled = false;
      try {
        await expect(
          outcome(service.startInstall(member(tenant), { locale: 'en' })),
        ).resolves.toEqual({
          status: 404,
          code: 'EASYORDERS_CONNECT_UNAVAILABLE',
        });
        await expect(
          callback(started.callbackToken, liveKey(), 'store-off'),
        ).resolves.toEqual({
          status: 404,
          code: 'EASYORDERS_CONNECT_UNAVAILABLE',
        });
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'unavailable',
        });
      } finally {
        settings.enabled = true;
      }
      await expectNothingProvisioned(tenant);
    });

    it('stops honouring an open context once the organization leaves the allow-list', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      settings.pilotOrgIds.splice(
        settings.pilotOrgIds.indexOf(tenant.orgId),
        1,
      );

      await expect(
        callback(started.callbackToken, liveKey(), 'store-delisted'),
      ).resolves.toEqual({
        status: 401,
        code: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
      });
      await expectNothingProvisioned(tenant);
    });
  });

  describe('install context', () => {
    it('rejects an expired context without mutation', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      await client`UPDATE easyorders_pending_installs SET expires_at = now() - interval '1 second' WHERE org_id = ${tenant.orgId}`;
      const probesBefore = probedKeys.length;

      await expect(
        callback(started.callbackToken, liveKey(), 'store-expired'),
      ).resolves.toEqual({
        status: 401,
        code: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
      });

      // The key is not even sent to EasyOrders for a dead context.
      expect(probedKeys).toHaveLength(probesBefore);
      await expectNothingProvisioned(tenant);
      await expect(status(tenant)).resolves.toMatchObject({ state: 'expired' });
    });

    it('rejects a replayed callback and leaves the stored credentials untouched', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      await callback(started.callbackToken, liveKey(), 'store-replay');
      const [before] = await connectionsOf(tenant.orgId);

      await expect(
        callback(started.callbackToken, liveKey(), 'store-attacker'),
      ).resolves.toEqual({
        status: 401,
        code: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
      });

      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      const [after] = await connectionsOf(tenant.orgId);
      expect(after).toEqual(before);
    });

    it.each([
      ['an unknown token', randomBytes(32).toString('base64url')],
      ['a malformed token', 'not-a-token'],
      ['an empty token', ''],
    ])('rejects %s', async (_label, token) => {
      await expect(callback(token, liveKey(), 'store-forged')).resolves.toEqual(
        { status: 401, code: 'EASYORDERS_INSTALL_CONTEXT_INVALID' },
      );
    });

    it('retires the earlier context when a new install is started', async () => {
      const tenant = await createTenant();
      const first = await start(tenant);
      const second = await start(tenant);

      await expect(
        callback(first.callbackToken, liveKey(), 'store-first'),
      ).resolves.toEqual({
        status: 401,
        code: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
      });
      await expectNothingProvisioned(tenant);

      await expect(
        callback(second.callbackToken, liveKey(), 'store-second'),
      ).resolves.toEqual({ status: 204 });
      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection.store_id).toBe('store-second');
    });

    it.each([
      ['no body', undefined],
      ['an array', []],
      ['a missing key', { store_id: 'store-shape' }],
      ['a missing store', { api_key: 'key-shape' }],
      ['a non-string key', { api_key: 42, store_id: 'store-shape' }],
      ['a key with spaces', { api_key: 'a b', store_id: 'store-shape' }],
      ['an oversized store id', { api_key: 'k', store_id: 'x'.repeat(129) }],
    ])('rejects a callback with %s', async (_label, body) => {
      const tenant = await createTenant();
      const started = await start(tenant);

      await expect(
        outcome(service.handleCallback(started.callbackToken, body)),
      ).resolves.toEqual({ status: 400, code: 'EASYORDERS_CALLBACK_INVALID' });
      await expectNothingProvisioned(tenant);
    });
  });

  describe('credential check', () => {
    it.each([
      ['a key EasyOrders answers 401 for', 'unauthorized'],
      // Fail closed: an unknown order is not proof of a recognized key.
      ['a key EasyOrders answers 404 for', 'not_found'],
    ] as const)('rejects %s without mutation', async (_label, answer) => {
      const tenant = await createTenant();
      const started = await start(tenant);

      await expect(
        callback(started.callbackToken, liveKey(answer), 'store-bad-key'),
      ).resolves.toEqual({ status: 422, code: 'EASYORDERS_KEY_REJECTED' });

      await expectNothingProvisioned(tenant);
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'failed',
        lastErrorCode: 'EASYORDERS_KEY_REJECTED',
      });
    });

    it('kills a context after five refused callbacks, even for a good key', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      for (let attempt = 0; attempt < 5; attempt++) {
        await callback(
          started.callbackToken,
          liveKey('unauthorized'),
          'store-oracle',
        );
      }

      await expect(
        callback(started.callbackToken, liveKey(), 'store-oracle'),
      ).resolves.toEqual({
        status: 401,
        code: 'EASYORDERS_INSTALL_CONTEXT_INVALID',
      });
      await expectNothingProvisioned(tenant);
    });

    it('stores nothing when EasyOrders cannot be reached, and the same link works on retry', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      const key = liveKey('down');

      await expect(
        callback(started.callbackToken, key, 'store-retry'),
      ).resolves.toEqual({
        status: 503,
        code: 'EASYORDERS_PROVIDER_UNAVAILABLE',
      });
      await expectNothingProvisioned(tenant);

      providerAnswers.set(key, 'live');
      await expect(
        callback(started.callbackToken, key, 'store-retry'),
      ).resolves.toEqual({ status: 204 });
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
    });
  });

  describe('store binding', () => {
    it('rejects a store that is verified for another organization and leaves that connection untouched', async () => {
      const owner = await createTenant();
      const ownerInstall = await start(owner);
      await callback(ownerInstall.callbackToken, liveKey(), 'store-owned');
      await client`UPDATE easyorders_connections SET store_verified_at = now() WHERE org_id = ${owner.orgId}`;
      const [before] = await connectionsOf(owner.orgId);

      const attacker = await createTenant();
      const attackerInstall = await start(attacker);
      await expect(
        callback(attackerInstall.callbackToken, liveKey(), 'store-owned'),
      ).resolves.toEqual({
        status: 409,
        code: 'EASYORDERS_STORE_UNAVAILABLE',
      });

      await expectNothingProvisioned(attacker);
      const [after] = await connectionsOf(owner.orgId);
      expect(after).toEqual(before);
      await expect(status(attacker)).resolves.toMatchObject({
        state: 'failed',
        lastErrorCode: 'EASYORDERS_STORE_UNAVAILABLE',
      });
    });

    it('does not let an unverified claim hold the store against another organization', async () => {
      const claimant = await createTenant();
      const realOwner = await createTenant();
      const first = await start(claimant);
      const second = await start(realOwner);

      await expect(
        callback(first.callbackToken, liveKey(), 'store-contested'),
      ).resolves.toEqual({ status: 204 });
      await expect(
        callback(second.callbackToken, liveKey(), 'store-contested'),
      ).resolves.toEqual({ status: 204 });

      // Once one of them is verified, a second verification cannot happen.
      await client`UPDATE easyorders_connections SET store_verified_at = now() WHERE org_id = ${realOwner.orgId}`;
      await expect(
        client`UPDATE easyorders_connections SET store_verified_at = now() WHERE org_id = ${claimant.orgId}`,
      ).rejects.toThrow(/easyorders_connections_verified_store_key/);
    });
  });

  describe('tenant isolation', () => {
    it('a callback provisions only the organization that started the install, and another tenant cannot read or change it', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const started = await start(tenantA);

      await expect(
        callback(started.callbackToken, liveKey(), 'store-tenant-a'),
      ).resolves.toEqual({ status: 204 });

      await expectNothingProvisioned(tenantB);
      await expect(status(tenantB)).resolves.toMatchObject({
        state: 'ready',
        connection: null,
      });

      await expect(
        outcome(
          service.saveWebhookSecrets(member(tenantB), {
            ordersSecret: 'cross-tenant-orders',
            statusSecret: 'cross-tenant-status',
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'EASYORDERS_NOT_CONNECTED' });
      const [connection] = await connectionsOf(tenantA.orgId);
      expect(connection.orders_webhook_secret_encrypted).toBeNull();
      expect(connection.status_webhook_secret_encrypted).toBeNull();
    });
  });

  describe('existing source', () => {
    it.each(['standalone', 'shopify'] as const)(
      'refuses to start for an organization with an active %s source',
      async (platform) => {
        const tenant = await createTenant();
        await client`INSERT INTO integrations (org_id, platform_type, platform_store_url) VALUES (${tenant.orgId}, ${platform}, ${`${platform}:${tenant.orgId}`})`;
        const [before] = await integrationsOf(tenant.orgId);

        await expect(
          outcome(service.startInstall(member(tenant), { locale: 'en' })),
        ).resolves.toEqual({ status: 409, code: 'EASYORDERS_SOURCE_EXISTS' });

        await expect(integrationsOf(tenant.orgId)).resolves.toEqual([before]);
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'source_exists',
        });
      },
    );

    it('refuses an inactive source of another platform: there is no source switching', async () => {
      const tenant = await createTenant();
      await client`INSERT INTO integrations (org_id, platform_type, platform_store_url, is_active) VALUES (${tenant.orgId}, 'standalone', ${`standalone:${tenant.orgId}`}, false)`;

      await expect(
        outcome(service.startInstall(member(tenant), { locale: 'en' })),
      ).resolves.toEqual({ status: 409, code: 'EASYORDERS_SOURCE_EXISTS' });
    });

    it('rejects a callback when a source appeared after the install was started, without touching it', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      await client`INSERT INTO integrations (org_id, platform_type, platform_store_url) VALUES (${tenant.orgId}, 'standalone', ${`standalone:${tenant.orgId}`})`;
      const [before] = await integrationsOf(tenant.orgId);

      await expect(
        callback(started.callbackToken, liveKey(), 'store-late'),
      ).resolves.toEqual({ status: 409, code: 'EASYORDERS_SOURCE_EXISTS' });

      await expect(integrationsOf(tenant.orgId)).resolves.toEqual([before]);
      await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(0);
    });
  });

  describe('concurrency and partial failure', () => {
    it('two callbacks on one link produce one source', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);

      const results = await Promise.all([
        callback(started.callbackToken, liveKey(), 'store-race'),
        callback(started.callbackToken, liveKey(), 'store-race'),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([204, 401]);
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(1);
    });

    it('two open contexts for one organization produce one source', async () => {
      const tenant = await createTenant();
      const first = await start(tenant);
      const second = await start(tenant);
      // Reopen the retired context, as if both had been created at once.
      await client`UPDATE easyorders_pending_installs SET superseded_at = NULL WHERE org_id = ${tenant.orgId}`;

      const results = await Promise.all([
        callback(first.callbackToken, liveKey(), 'store-double-a'),
        callback(second.callbackToken, liveKey(), 'store-double-b'),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([204, 409]);
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(1);
    });

    it('concurrent starts leave exactly one usable context', async () => {
      const tenant = await createTenant();
      const owner = member(tenant);

      await Promise.all([start(tenant, owner), start(tenant, owner)]);

      const open = await client`
        SELECT id FROM easyorders_pending_installs
        WHERE org_id = ${tenant.orgId} AND consumed_at IS NULL AND superseded_at IS NULL`;
      expect(open).toHaveLength(1);
    });

    it('a new install started while a callback holds the open context is retried past the deadlock', async () => {
      const tenant = await createTenant();
      await start(tenant);
      let restarted: Promise<StartedInstall> | undefined;

      // The callback's lock order, by hand: the open context, then the
      // organization. The new install takes them the other way round.
      const callbackTx = await client.reserve();
      try {
        await callbackTx`BEGIN`;
        await callbackTx`
          SELECT id FROM easyorders_pending_installs
          WHERE org_id = ${tenant.orgId} FOR UPDATE`;
        restarted = start(tenant);
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
        SELECT id FROM easyorders_pending_installs
        WHERE org_id = ${tenant.orgId} AND consumed_at IS NULL AND superseded_at IS NULL`;
      expect(open).toHaveLength(1);
    });

    it('rolls the whole provisioning back when a write fails, and the same link then succeeds', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      const key = liveKey();

      await client`UPDATE fault_switch SET fail = true`;
      try {
        await expect(
          service.handleCallback(started.callbackToken, {
            api_key: key,
            store_id: 'store-partial',
          }),
        ).rejects.toThrow();
      } finally {
        await client`UPDATE fault_switch SET fail = false`;
      }
      await expectNothingProvisioned(tenant);
      const [pending] = await client<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM easyorders_pending_installs WHERE org_id = ${tenant.orgId}`;
      expect(pending.consumed_at).toBeNull();

      await expect(
        callback(started.callbackToken, key, 'store-partial'),
      ).resolves.toEqual({ status: 204 });
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      await expect(connectionsOf(tenant.orgId)).resolves.toHaveLength(1);
    });
  });

  describe('webhook secrets', () => {
    it('stores both secrets encrypted and reports only that they are set', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      await callback(started.callbackToken, liveKey(), 'store-secrets');
      const ordersSecret = randomBytes(12).toString('base64');
      const statusSecret = randomBytes(12).toString('base64');
      secrets.add(ordersSecret);
      secrets.add(statusSecret);

      const saved = await service.saveWebhookSecrets(member(tenant, 'admin'), {
        ordersSecret,
        statusSecret,
      });
      responses.push(saved);

      expect(saved).toMatchObject({
        state: 'connected',
        connection: { ordersSecretSet: true, statusSecretSet: true },
      });
      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection.orders_webhook_secret_encrypted).toMatch(/^v1:/);
      expect(
        decryptToken(
          connection.orders_webhook_secret_encrypted!,
          ENCRYPTION_KEY,
        ),
      ).toBe(ordersSecret);
      expect(
        decryptToken(
          connection.status_webhook_secret_encrypted!,
          ENCRYPTION_KEY,
        ),
      ).toBe(statusSecret);
    });

    it('refuses plaintext in the credential columns', async () => {
      const tenant = await createTenant();
      const started = await start(tenant);
      await callback(started.callbackToken, liveKey(), 'store-plaintext');

      await expect(
        client`UPDATE easyorders_connections SET orders_webhook_secret_encrypted = 'plain' WHERE org_id = ${tenant.orgId}`,
      ).rejects.toThrow(/orders_secret_encrypted_check/);
      await expect(
        client`UPDATE easyorders_connections SET api_key_encrypted = 'plain' WHERE org_id = ${tenant.orgId}`,
      ).rejects.toThrow(/api_key_encrypted_check/);
    });
  });

  describe('disconnect and reconnect (US-06-05)', () => {
    async function connectTenant(storeId: string, answer?: ProviderAnswer) {
      const tenant = await createTenant();
      const started = await start(tenant);
      const apiKey = liveKey(answer);
      await expect(
        callback(started.callbackToken, apiKey, storeId),
      ).resolves.toEqual({ status: 204 });
      await service.saveOrderSettings(member(tenant), {
        currency: 'EGP',
        phoneCountry: 'EG',
      });
      await service.saveWebhookSecrets(member(tenant), {
        ordersSecret: 'orders-secret-0001',
        statusSecret: 'status-secret-0001',
      });
      return { tenant, started, apiKey };
    }

    const webhookUrls = (started: StartedInstall) =>
      ['orders', 'status'].map(
        (kind) =>
          `${settings.publicApiBaseUrl}/webhooks/easyorders/${kind}/${started.webhookToken}`,
      );

    async function disconnect(tenant: Tenant, user = member(tenant)) {
      const result = await service.disconnect(user);
      responses.push(result);
      return result;
    }

    it('stops the source and wipes every credential, keeping the store and the integration', async () => {
      const { tenant, started } = await connectTenant('store-disconnect');
      await client`UPDATE easyorders_connections SET store_verified_at = now() WHERE org_id = ${tenant.orgId}`;
      const [before] = await integrationsOf(tenant.orgId);
      const owner = member(tenant);

      await expect(disconnect(tenant, owner)).resolves.toMatchObject({
        state: 'disconnected',
        connection: {
          storeId: 'store-disconnect',
          storeVerified: false,
          webhookUrlHint: null,
          ordersSecretSet: false,
          statusSecretSet: false,
          currency: 'EGP',
          phoneCountry: 'EG',
          providerCleanup: 'removed',
        },
      });
      // Both webhooks of this install were deleted at EasyOrders, by address.
      for (const url of webhookUrls(started))
        expect(webhookDeletes).toContain(url);

      const [after] = await integrationsOf(tenant.orgId);
      expect(after).toMatchObject({
        id: before.id,
        is_active: false,
        platform_store_url: before.platform_store_url,
        onboarding_status: before.onboarding_status,
        billing_plan_id: before.billing_plan_id,
        store_name: before.store_name,
      });
      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection).toMatchObject({
        integration_id: before.id,
        store_id: 'store-disconnect',
        store_verified_at: null,
        api_key_encrypted: null,
        webhook_token_hash: null,
        webhook_token_hint: null,
        webhook_token_encrypted: null,
        provider_cleanup: 'removed',
        orders_webhook_secret_encrypted: null,
        status_webhook_secret_encrypted: null,
        disconnected_by: owner.userId,
      });
      expect(connection.disconnected_at).not.toBeNull();
    });

    it.each([
      ['EasyOrders cannot be reached', 'down' as const],
      ['EasyOrders refuses the key', 'unauthorized' as const],
    ])(
      'still disconnects when %s, and leaves the webhooks to the merchant',
      async (_label, answer) => {
        const { tenant, apiKey } = await connectTenant(`store-${answer}`);
        providerAnswers.set(apiKey, answer);

        await expect(disconnect(tenant)).resolves.toMatchObject({
          state: 'disconnected',
          connection: { providerCleanup: 'manual' },
        });
        const [connection] = await connectionsOf(tenant.orgId);
        expect(connection).toMatchObject({
          api_key_encrypted: null,
          webhook_token_encrypted: null,
          provider_cleanup: 'manual',
        });
      },
    );

    it('asks EasyOrders for nothing when the connection predates the kept token', async () => {
      const { tenant } = await connectTenant('store-legacy');
      await client`UPDATE easyorders_connections SET webhook_token_encrypted = NULL WHERE org_id = ${tenant.orgId}`;
      const deletesBefore = webhookDeletes.length;

      await expect(disconnect(tenant)).resolves.toMatchObject({
        connection: { providerCleanup: 'manual' },
      });
      expect(webhookDeletes).toHaveLength(deletesBefore);
    });

    it('a second disconnect changes nothing', async () => {
      const { tenant } = await connectTenant('store-twice');
      await disconnect(tenant);
      const [first] = await connectionsOf(tenant.orgId);

      await expect(disconnect(tenant)).resolves.toMatchObject({
        state: 'disconnected',
      });

      await expect(connectionsOf(tenant.orgId)).resolves.toEqual([first]);
    });

    it('stays readable as disconnected with the connect switch off', async () => {
      const { tenant } = await connectTenant('store-switch-off');
      settings.enabled = false;
      try {
        await expect(disconnect(tenant)).resolves.toMatchObject({
          state: 'disconnected',
        });
        await expect(status(tenant)).resolves.toMatchObject({
          state: 'disconnected',
          connection: { storeId: 'store-switch-off' },
        });
      } finally {
        settings.enabled = true;
      }
    });

    it("refuses a viewer's disconnect and reconnect", async () => {
      const { tenant } = await connectTenant('store-viewer');
      const viewer = member(tenant, 'viewer');
      const [before] = await connectionsOf(tenant.orgId);

      await expect(outcome(service.disconnect(viewer))).resolves.toEqual({
        status: 403,
        code: 'EASYORDERS_ROLE_REQUIRED',
      });
      await expect(connectionsOf(tenant.orgId)).resolves.toEqual([before]);

      await disconnect(tenant);
      await expect(
        outcome(service.startInstall(viewer, { locale: 'en' })),
      ).resolves.toEqual({ status: 403, code: 'EASYORDERS_ROLE_REQUIRED' });
      await expect(status(tenant, viewer)).resolves.toMatchObject({
        state: 'disconnected',
        canManage: false,
      });
    });

    it('answers an organization with no connection as not connected', async () => {
      const tenant = await createTenant();

      await expect(
        outcome(service.disconnect(member(tenant))),
      ).resolves.toEqual({ status: 404, code: 'EASYORDERS_NOT_CONNECTED' });
    });

    it('retires an install link opened before the disconnect', async () => {
      const { tenant } = await connectTenant('store-stale-link');
      // A context left open, as if a second tab had started an install.
      const [stale] = await client<{ id: string }[]>`
        INSERT INTO easyorders_pending_installs
          (org_id, created_by, callback_token_hash, webhook_token_hash, webhook_token_hint, expires_at)
        VALUES (${tenant.orgId}, ${randomUUID()}, ${'a'.repeat(64)}, ${'b'.repeat(64)}, 'stale1', now() + interval '10 minutes')
        RETURNING id`;

      await disconnect(tenant);

      const [row] = await client<{ superseded_at: Date | null }[]>`
        SELECT superseded_at FROM easyorders_pending_installs WHERE id = ${stale.id}`;
      expect(row.superseded_at).not.toBeNull();
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'disconnected',
      });
    });

    it('settings and secrets cannot be written to a disconnected source', async () => {
      const { tenant } = await connectTenant('store-no-writes');
      await disconnect(tenant);

      await expect(
        outcome(
          service.saveWebhookSecrets(member(tenant), {
            ordersSecret: 'orders-secret-0002',
            statusSecret: 'status-secret-0002',
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'EASYORDERS_NOT_CONNECTED' });
      await expect(
        outcome(
          service.saveOrderSettings(member(tenant), {
            currency: 'SAR',
            phoneCountry: 'SA',
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'EASYORDERS_NOT_CONNECTED' });
      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection).toMatchObject({
        currency: 'EGP',
        orders_webhook_secret_encrypted: null,
      });
    });

    it('a disconnected row can hold no credential and no verified claim', async () => {
      const { tenant } = await connectTenant('store-check');
      await disconnect(tenant);

      for (const assignment of [
        "api_key_encrypted = 'v1:left-behind'",
        `webhook_token_hash = '${'c'.repeat(64)}'`,
        "orders_webhook_secret_encrypted = 'v1:left-behind'",
        "webhook_token_encrypted = 'v1:left-behind'",
        'store_verified_at = now()',
      ])
        await expect(
          client.unsafe(
            `UPDATE easyorders_connections SET ${assignment} WHERE org_id = '${tenant.orgId}'`,
          ),
        ).rejects.toThrow(/credentials_state_check/);
      await expect(
        client`UPDATE easyorders_connections SET api_key_encrypted = NULL WHERE disconnected_at IS NULL`,
      ).rejects.toThrow(/credentials_state_check/);
      // The cleanup outcome belongs to a disconnected row, and is one of two.
      await expect(
        client`UPDATE easyorders_connections SET provider_cleanup = 'removed' WHERE disconnected_at IS NULL`,
      ).rejects.toThrow(/provider_cleanup_check/);
      await expect(
        client`UPDATE easyorders_connections SET provider_cleanup = 'unknown' WHERE org_id = ${tenant.orgId}`,
      ).rejects.toThrow(/provider_cleanup_check/);
    });

    it('reconnects the same store in place, with a new key and address and no secrets', async () => {
      const { tenant, started: first } = await connectTenant('store-same');
      await client`UPDATE easyorders_connections SET store_verified_at = now(), rejected_deliveries = 4, last_rejected_at = now() WHERE org_id = ${tenant.orgId}`;
      const [source] = await integrationsOf(tenant.orgId);
      await client`UPDATE integrations SET onboarding_status = 'completed' WHERE id = ${source.id as string}`;
      await disconnect(tenant);

      const second = await start(tenant);
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'pending',
        connection: { storeId: 'store-same' },
      });
      const key = liveKey();
      await expect(
        callback(second.callbackToken, key, 'store-same'),
      ).resolves.toEqual({ status: 204 });

      const sources = await integrationsOf(tenant.orgId);
      // A reconnect never grants twice.
      await expect(launchGrantOf(tenant.orgId)).resolves.toMatchObject({
        account: { posted_balance: 30 },
        grants: [{ quantity: 30 }],
      });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        id: source.id,
        platform_store_url: source.platform_store_url,
        is_active: true,
        onboarding_status: 'completed',
      });
      const [connection] = await connectionsOf(tenant.orgId);
      expect(connection).toMatchObject({
        integration_id: source.id,
        store_id: 'store-same',
        // The new key has proven nothing yet (contract record section 2).
        store_verified_at: null,
        orders_webhook_secret_encrypted: null,
        status_webhook_secret_encrypted: null,
        health: 'ok',
        rejected_deliveries: 0,
        disconnected_at: null,
        disconnected_by: null,
        provider_cleanup: null,
        currency: 'EGP',
        phone_country: 'EG',
      });
      expect(decryptToken(connection.api_key_encrypted!, ENCRYPTION_KEY)).toBe(
        key,
      );
      expect(
        decryptToken(connection.webhook_token_encrypted!, ENCRYPTION_KEY),
      ).toBe(second.webhookToken);
      // The old address is gone and the new one resolves to this source.
      await expect(
        repository.findByWebhookTokenHash(hashInstallToken(first.webhookToken)),
      ).resolves.toBeUndefined();
      await expect(
        repository.findByWebhookTokenHash(
          hashInstallToken(second.webhookToken),
        ),
      ).resolves.toMatchObject({
        sourceActive: true,
        connection: { integrationId: source.id },
      });
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'connected',
        connection: {
          ordersSecretSet: false,
          statusSecretSet: false,
          disconnectedAt: null,
        },
      });
    });

    it('a refused reconnect leaves the source disconnected and unchanged, and the next attempt connects', async () => {
      const { tenant } = await connectTenant('store-retry');
      await disconnect(tenant);
      const [before] = await connectionsOf(tenant.orgId);

      const wrongStore = await start(tenant);
      await expect(
        callback(wrongStore.callbackToken, liveKey(), 'store-other'),
      ).resolves.toEqual({
        status: 409,
        code: 'EASYORDERS_RECONNECT_STORE_MISMATCH',
      });
      await expect(connectionsOf(tenant.orgId)).resolves.toEqual([before]);
      await expect(integrationsOf(tenant.orgId)).resolves.toMatchObject([
        { is_active: false },
      ]);
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'failed',
        lastErrorCode: 'EASYORDERS_RECONNECT_STORE_MISMATCH',
        connection: { storeId: 'store-retry' },
      });

      const rejectedKey = await start(tenant);
      await expect(
        callback(
          rejectedKey.callbackToken,
          liveKey('unauthorized'),
          'store-retry',
        ),
      ).resolves.toEqual({ status: 422, code: 'EASYORDERS_KEY_REJECTED' });
      await expect(connectionsOf(tenant.orgId)).resolves.toEqual([before]);

      const retry = await start(tenant);
      await expect(
        callback(retry.callbackToken, liveKey(), 'store-retry'),
      ).resolves.toEqual({ status: 204 });
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'connected',
      });
    });

    it('a key EasyOrders rejects is recovered by disconnect then reconnect, on the same source', async () => {
      const { tenant } = await connectTenant('store-expired-key');
      const [source] = await integrationsOf(tenant.orgId);
      await repository.setHealth(
        source.id as string,
        tenant.orgId,
        'credentials_rejected',
      );
      await expect(status(tenant)).resolves.toMatchObject({
        state: 'connected',
        connection: { health: 'credentials_rejected' },
      });
      // Reconnect is offered only from the disconnected state.
      await expect(
        outcome(service.startInstall(member(tenant), { locale: 'ar' })),
      ).resolves.toEqual({ status: 409, code: 'EASYORDERS_SOURCE_EXISTS' });

      await disconnect(tenant);
      const again = await start(tenant);
      await expect(
        callback(again.callbackToken, liveKey(), 'store-expired-key'),
      ).resolves.toEqual({ status: 204 });

      await expect(status(tenant)).resolves.toMatchObject({
        state: 'connected',
        connection: { health: 'ok' },
      });
      await expect(integrationsOf(tenant.orgId)).resolves.toMatchObject([
        { id: source.id, is_active: true },
      ]);
    });

    it('refuses a reconnect when another organization has verified the store since', async () => {
      const { tenant } = await connectTenant('store-taken-since');
      await client`UPDATE easyorders_connections SET store_verified_at = now() WHERE org_id = ${tenant.orgId}`;
      await disconnect(tenant);
      // The slot is free once disconnected: the real owner connects and proves it.
      const { tenant: owner } = await connectTenant('store-taken-since');
      await client`UPDATE easyorders_connections SET store_verified_at = now() WHERE org_id = ${owner.orgId}`;

      const again = await start(tenant);
      await expect(
        callback(again.callbackToken, liveKey(), 'store-taken-since'),
      ).resolves.toEqual({ status: 409, code: 'EASYORDERS_STORE_UNAVAILABLE' });
      await expect(integrationsOf(tenant.orgId)).resolves.toMatchObject([
        { is_active: false },
      ]);
    });

    it('another tenant cannot disconnect this connection or reconnect into its store', async () => {
      const { tenant: tenantA } = await connectTenant('store-tenant-a-live');
      await client`UPDATE easyorders_connections SET store_verified_at = now() WHERE org_id = ${tenantA.orgId}`;
      const [before] = await connectionsOf(tenantA.orgId);
      const { tenant: tenantB } = await connectTenant('store-tenant-b');

      // B has no way to name A: every call is scoped by B's own organization.
      await disconnect(tenantB);
      await expect(connectionsOf(tenantA.orgId)).resolves.toEqual([before]);
      await expect(integrationsOf(tenantA.orgId)).resolves.toMatchObject([
        { is_active: true },
      ]);

      // B reconnecting with A's store id is a different store than B's own.
      const asA = await start(tenantB);
      await expect(
        callback(asA.callbackToken, liveKey(), 'store-tenant-a-live'),
      ).resolves.toEqual({ status: 409, code: 'EASYORDERS_STORE_UNAVAILABLE' });
      await expect(connectionsOf(tenantA.orgId)).resolves.toEqual([before]);
      await expect(status(tenantB)).resolves.toMatchObject({
        state: 'failed',
        connection: { storeId: 'store-tenant-b' },
      });

      // A tenant that never connected gets nothing to disconnect.
      const tenantC = await createTenant();
      await expect(
        outcome(service.disconnect(member(tenantC))),
      ).resolves.toEqual({ status: 404, code: 'EASYORDERS_NOT_CONNECTED' });
    });

    it('does not let a merchant reconnect a source that was switched off without a disconnect', async () => {
      const { tenant } = await connectTenant('store-staff-off');
      await client`UPDATE integrations SET is_active = false WHERE org_id = ${tenant.orgId}`;

      await expect(
        outcome(service.startInstall(member(tenant), { locale: 'en' })),
      ).resolves.toEqual({ status: 409, code: 'EASYORDERS_SOURCE_EXISTS' });
    });

    it('two reconnect callbacks at once bring the source back once', async () => {
      const { tenant } = await connectTenant('store-reconnect-race');
      await disconnect(tenant);
      const again = await start(tenant);

      const results = await Promise.all([
        callback(again.callbackToken, liveKey(), 'store-reconnect-race'),
        callback(again.callbackToken, liveKey(), 'store-reconnect-race'),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([204, 401]);
      await expect(integrationsOf(tenant.orgId)).resolves.toHaveLength(1);
      await expect(connectionsOf(tenant.orgId)).resolves.toMatchObject([
        { disconnected_at: null },
      ]);
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
      await expect(
        client`SELECT role FROM memberships WHERE org_id = ${tenant.orgId} AND user_id = ${userId}`,
      ).resolves.toEqual([{ role: 'owner' }]);

      settings.pilotOrgIds.push(tenant.orgId);
      const started = await start(tenant, {
        userId,
        orgId: tenant.orgId,
        role: 'owner',
        source: 'supabase',
      });
      await expect(
        callback(started.callbackToken, liveKey(), 'store-signup'),
      ).resolves.toEqual({ status: 204 });
      const sources = await integrationsOf(tenant.orgId);
      expect(sources.map((source) => source.platform_type)).toEqual([
        'easyorders',
      ]);
    });
  });

  describe('secrets and grants', () => {
    it('never puts a key, token or webhook secret in a response, a log line or a stored column', async () => {
      expect(secrets.size).toBeGreaterThan(20);
      const returned = JSON.stringify(responses);
      const logged = logs.join('\n');
      const stored = JSON.stringify([
        await client`SELECT * FROM easyorders_connections`,
        await client`SELECT * FROM easyorders_pending_installs`,
        await client`SELECT * FROM integrations`,
      ]);
      expect(logs.length).toBeGreaterThan(20);

      for (const secret of secrets) {
        expect(returned.includes(secret)).toBe(false);
        expect(logged.includes(secret)).toBe(false);
        expect(stored.includes(secret)).toBe(false);
      }
    });

    it('the install link is the only response that carries the tokens', async () => {
      const tenant = await createTenant();
      const started = await service.startInstall(member(tenant), {
        locale: 'en',
      });
      const params = new URLSearchParams(started.installUrl.split('?')[1]);

      expect(
        started.installUrl.startsWith(
          'https://app.easy-orders.net/#/install-app?',
        ),
      ).toBe(true);
      expect(params.get('permissions')).toBe('orders:read,orders:update');
      expect(params.get('callback_url')).toMatch(
        /^https:\/\/api\.akeed\.test\/api\/easyorders\/install\/callback\/[A-Za-z0-9_-]{43}$/,
      );
      expect(params.get('redirect_url')).toBe(
        'https://app.akeed.test/en/onboarding',
      );
      expect(params.get('callback_url')!.split('/').pop()).not.toBe(
        params.get('orders_webhook')!.split('/').pop(),
      );
    });

    it.each(['authenticated', 'anon'])(
      'gives the %s role no access to either table',
      async (role) => {
        for (const table of [
          'easyorders_connections',
          'easyorders_pending_installs',
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
