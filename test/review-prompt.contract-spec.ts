import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/infrastructure/database';
import {
  ReviewPromptsRepository,
  type ReviewPromptMerchantScope,
} from '../src/infrastructure/database/repositories/review-prompts.repository';

function isolatedDatabaseUrl(): string {
  const value = process.env.E01_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E01_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
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

const REQUESTS_MIGRATION = '0070_review_prompts.sql';
const STATES_MIGRATION = '0071_review_prompt_states.sql';
const namespace = `review_prompt_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 6,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const repository = new ReviewPromptsRepository(
  drizzle(client, { schema }) as never,
);
const STAFF = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const AUDIT = { userId: STAFF, requestId: 'req-contract' };
/** The test trigger refuses events written by this actor. */
const FAILING_ACTOR = 'actor-that-fails';
let created = false;

/** Stores answered under 0070, before the per-store state existed. */
const legacy: Record<
  'dont_ask_again' | 'review_clicked' | 'snoozed' | 'dismissed',
  { orgId: string; integrationId: string }
> = {} as never;

async function migrate(file: string): Promise<void> {
  await client.begin(async (tx) => {
    for (const statement of readFileSync(
      resolve(__dirname, '../drizzle', file),
      'utf8',
    ).split('--> statement-breakpoint')) {
      if (statement.trim()) await tx.unsafe(statement);
    }
  });
}

async function createStore(
  platformType = 'shopify',
): Promise<{ orgId: string; integrationId: string }> {
  const orgId = randomUUID();
  const integrationId = randomUUID();
  await client`
    INSERT INTO integrations (id, org_id, platform_type, platform_store_url, created_at)
    VALUES (${integrationId}, ${orgId}, ${platformType}, ${`${integrationId}.myshopify.com`}, '2026-01-01T00:00:00Z')`;
  return { orgId, integrationId };
}

async function enabledStore(): Promise<
  ReviewPromptMerchantScope & { requestId: string }
> {
  const store = await createStore();
  const result = await repository.enable(store.integrationId, AUDIT);
  if (result.outcome !== 'created') throw new Error(result.outcome);
  return { ...store, requestId: result.requestId, actorId: 'shopify-user-1' };
}

async function stateRow(integrationId: string) {
  const [row] = await client<
    {
      state: string;
      snoozed_until: string | null;
      snooze_count: number;
      shown_count: number;
      last_shown_at: string | null;
      last_result_code: string | null;
    }[]
  >`SELECT state, snoozed_until, snooze_count, shown_count, last_shown_at, last_result_code
    FROM review_prompt_states WHERE integration_id = ${integrationId}`;
  return row;
}

async function events(integrationId: string) {
  return client<
    {
      event: string;
      actor_type: string;
      request_id: string | null;
      result_code: string | null;
    }[]
  >`
    SELECT event, actor_type, request_id, result_code FROM review_prompt_events
    WHERE integration_id = ${integrationId} ORDER BY created_at, id`;
}

async function auditActions(integrationId: string) {
  const rows = await client<{ action: string }[]>`
    SELECT action FROM admin_access_audit
    WHERE target_integration_id = ${integrationId} ORDER BY created_at`;
  return rows.map((row) => row.action);
}

async function expireSnooze(integrationId: string) {
  await client`UPDATE review_prompt_states SET snoozed_until = now() - interval '1 minute'
    WHERE integration_id = ${integrationId}`;
}

/** One order with one verification of the given outcome. */
async function addOutcome(
  store: { orgId: string; integrationId: string },
  outcome: {
    status: 'confirmed' | 'canceled' | 'no_reply' | 'sent';
    confirmationSource?: string;
    cancellationSource?: string;
    isTest?: boolean;
    externalOrderId?: string;
    createdAt?: string;
  },
) {
  const orderId = randomUUID();
  await client`
    INSERT INTO orders (id, org_id, integration_id, external_order_id, is_test)
    VALUES (${orderId}, ${store.orgId}, ${store.integrationId},
      ${outcome.externalOrderId ?? `order-${orderId}`}, ${outcome.isTest ?? false})`;
  const at = outcome.createdAt ?? '2026-10-01T10:00:00Z';
  await client`
    INSERT INTO verifications (id, org_id, order_id, status, created_at, confirmed_at, canceled_at, confirmation_source, cancellation_source)
    VALUES (${randomUUID()}, ${store.orgId}, ${orderId}, ${outcome.status}, ${at},
      ${outcome.status === 'confirmed' ? at : null},
      ${outcome.status === 'canceled' ? at : null},
      ${outcome.status === 'confirmed' ? (outcome.confirmationSource ?? 'customer') : null},
      ${outcome.status === 'canceled' ? (outcome.cancellationSource ?? 'customer') : null})`;
}

async function addLifecycle(
  store: { orgId: string; integrationId: string },
  installedAt: string,
  uninstalledAt: string | null,
) {
  await client`
    INSERT INTO admin_store_lifecycles (org_id, integration_id, installed_at, uninstalled_at)
    VALUES (${store.orgId}, ${store.integrationId}, ${installedAt}, ${uninstalledAt})`;
}

describe('review prompt against PostgreSQL', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE integrations (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        platform_type text NOT NULL,
        platform_store_url text NOT NULL,
        is_active boolean DEFAULT true,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT integrations_id_org_id_key UNIQUE (id, org_id)
      );
      CREATE TABLE admin_access_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid,
        action text NOT NULL,
        outcome text NOT NULL,
        request_id text,
        target_integration_id uuid,
        metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE orders (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        integration_id uuid NOT NULL,
        external_order_id text NOT NULL,
        is_test boolean DEFAULT false NOT NULL
      );
      CREATE TABLE verifications (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL,
        order_id uuid NOT NULL,
        status text NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL,
        confirmed_at timestamptz,
        canceled_at timestamptz,
        confirmation_source text,
        cancellation_source text
      );
      CREATE TABLE admin_store_lifecycles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        integration_id uuid NOT NULL,
        installed_at timestamptz NOT NULL,
        uninstalled_at timestamptz
      );
    `);
    await migrate(REQUESTS_MIGRATION);

    // Answers given under 0070 close their request; 0071 turns the latest
    // one of each store into its state.
    for (const answer of [
      'dont_ask_again',
      'review_clicked',
      'snoozed',
      'dismissed',
    ] as const) {
      const store = await createStore();
      legacy[answer] = store;
      await client`
        INSERT INTO review_prompt_requests (org_id, integration_id, status, enabled_by, closed_at, closed_action, closed_by)
        VALUES (${store.orgId}, ${store.integrationId}, 'answered', ${STAFF}, '2026-10-10T00:00:00Z', ${answer}, 'shopify-user-1')`;
    }

    await migrate(STATES_MIGRATION);
    // Applying both again proves they re-run cleanly.
    await migrate(REQUESTS_MIGRATION);
    await migrate(STATES_MIGRATION);
    await client.unsafe(`
      CREATE FUNCTION ${namespace}.refuse_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.actor_id = '${FAILING_ACTOR}' THEN
          RAISE EXCEPTION 'simulated event write failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_event BEFORE INSERT ON review_prompt_events
        FOR EACH ROW EXECUTE FUNCTION ${namespace}.refuse_event();
    `);
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  describe('backfill', () => {
    it.each([
      ['dont_ask_again', 'declined', 2, null],
      ['review_clicked', 'clicked', 0, null],
      ['snoozed', 'snoozed', 1, '2026-10-24T00:00:00.000Z'],
      ['dismissed', 'snoozed', 1, '2026-10-24T00:00:00.000Z'],
    ] as const)(
      'turns a legacy %s answer into %s',
      async (answer, state, snoozeCount, snoozedUntil) => {
        const row = await stateRow(legacy[answer].integrationId);
        expect(row).toMatchObject({ state, snooze_count: snoozeCount });
        expect(
          row.snoozed_until ? new Date(row.snoozed_until).toISOString() : null,
        ).toBe(snoozedUntil);
      },
    );

    it('leaves the switch of a legacy answered store off', async () => {
      const view = await repository.findMerchantView(
        legacy.snoozed.orgId,
        legacy.snoozed.integrationId,
      );
      expect(view.switchedOn).toBe(false);
    });

    it('still refuses to switch on a store that declined under 0070', async () => {
      await expect(
        repository.enable(legacy.dont_ask_again.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'opted_out' });
    });
  });

  describe('staff switch', () => {
    it('opens one request with its event and audit row', async () => {
      const store = await createStore();

      const first = await repository.enable(store.integrationId, AUDIT);
      const again = await repository.enable(store.integrationId, AUDIT);

      expect(first.outcome).toBe('created');
      expect(again).toEqual({
        outcome: 'already_pending',
        requestId: (first as { requestId: string }).requestId,
      });
      expect(await events(store.integrationId)).toEqual([
        expect.objectContaining({ event: 'enabled', actor_type: 'admin' }),
      ]);
      expect(await auditActions(store.integrationId)).toEqual([
        'store.review-prompt.enable',
      ]);
    });

    it('opens one request when staff switch it on concurrently', async () => {
      const store = await createStore();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.enable(store.integrationId, AUDIT),
        ),
      );

      expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    });

    it('refuses a store that is not on Shopify', async () => {
      const store = await createStore('standalone');
      await expect(
        repository.enable(store.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'unsupported_platform' });
    });

    it('reports an unknown store as not found', async () => {
      await expect(repository.enable(randomUUID(), AUDIT)).resolves.toEqual({
        outcome: 'not_found',
      });
    });

    it('switches off and on without touching the merchant state', async () => {
      const scope = await enabledStore();
      await repository.recordMerchantEvent(scope, 'not_now');

      await expect(
        repository.disable(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'disabled' });
      await expect(
        repository.disable(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'not_pending' });
      const again = await repository.enable(scope.integrationId, AUDIT);
      expect(again.outcome).toBe('created');

      expect(await stateRow(scope.integrationId)).toMatchObject({
        state: 'snoozed',
        snooze_count: 1,
      });
      await expect(
        repository.findMerchantView(scope.orgId, scope.integrationId),
      ).resolves.toMatchObject({
        switchedOn: true,
        state: { state: 'snoozed' },
      });
      expect(await auditActions(scope.integrationId)).toEqual([
        'store.review-prompt.enable',
        'store.review-prompt.disable',
        'store.review-prompt.enable',
      ]);
    });

    it('refuses to switch on a declined store until staff reset it', async () => {
      const scope = await enabledStore();
      await repository.recordMerchantEvent(scope, 'not_now');
      await expireSnooze(scope.integrationId);
      await repository.recordMerchantEvent(scope, 'not_now');
      await repository.disable(scope.integrationId, AUDIT);

      await expect(
        repository.enable(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'opted_out' });
      await expect(
        repository.reset(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'reset' });
      expect(
        (await repository.enable(scope.integrationId, AUDIT)).outcome,
      ).toBe('created');
    });
  });

  describe('merchant events', () => {
    it('counts each impression of an eligible prompt', async () => {
      const scope = await enabledStore();

      await repository.recordMerchantEvent(scope, 'shown');
      await repository.recordMerchantEvent(scope, 'shown');

      expect(await stateRow(scope.integrationId)).toMatchObject({
        state: 'eligible',
        shown_count: 2,
      });
      expect(
        (await events(scope.integrationId)).filter((e) => e.event === 'shown'),
      ).toEqual([
        expect.objectContaining({ request_id: scope.requestId }),
        expect.objectContaining({ request_id: scope.requestId }),
      ]);
    });

    it('records a click and its result with the code', async () => {
      const scope = await enabledStore();

      await repository.recordMerchantEvent(scope, 'clicked');
      await expect(
        repository.recordMerchantEvent(scope, 'result', 'success'),
      ).resolves.toEqual({ outcome: 'recorded' });

      expect(await stateRow(scope.integrationId)).toMatchObject({
        state: 'reviewed_prompted',
        last_result_code: 'success',
      });
      expect(
        (await events(scope.integrationId)).map((e) => [
          e.event,
          e.result_code,
        ]),
      ).toEqual([
        ['enabled', null],
        ['clicked', null],
        ['result', 'success'],
      ]);
      await expect(
        repository.recordMerchantEvent(scope, 'shown'),
      ).resolves.toEqual({ outcome: 'replayed' });
    });

    it('snoozes, replays a double "Not now", then declines after the snooze', async () => {
      const scope = await enabledStore();

      await expect(
        repository.recordMerchantEvent(scope, 'not_now'),
      ).resolves.toEqual({ outcome: 'recorded' });
      await expect(
        repository.recordMerchantEvent(scope, 'not_now'),
      ).resolves.toEqual({ outcome: 'replayed' });
      const snoozed = await stateRow(scope.integrationId);
      expect(snoozed).toMatchObject({ state: 'snoozed', snooze_count: 1 });
      const days =
        (Date.parse(snoozed.snoozed_until!) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);

      await expireSnooze(scope.integrationId);
      await repository.recordMerchantEvent(scope, 'not_now');

      expect(await stateRow(scope.integrationId)).toMatchObject({
        state: 'declined',
        snooze_count: 2,
        snoozed_until: null,
      });
      expect((await events(scope.integrationId)).map((e) => e.event)).toEqual([
        'enabled',
        'snoozed',
        'declined',
      ]);
    });

    it('applies concurrent "Not now" reports as one snooze', async () => {
      const scope = await enabledStore();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.recordMerchantEvent(scope, 'not_now'),
        ),
      );

      expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
      expect(await stateRow(scope.integrationId)).toMatchObject({
        state: 'snoozed',
        snooze_count: 1,
      });
    });

    it('logs an answer given after staff switched the prompt off', async () => {
      const scope = await enabledStore();
      await repository.disable(scope.integrationId, AUDIT);

      await repository.recordMerchantEvent(scope, 'result', 'already-reviewed');

      expect(await stateRow(scope.integrationId)).toMatchObject({
        state: 'reviewed',
      });
      expect((await events(scope.integrationId)).at(-1)).toMatchObject({
        event: 'result',
        request_id: null,
        result_code: 'already-reviewed',
      });
    });

    it('never writes the state of another store or org', async () => {
      const scope = await enabledStore();
      const other = await createStore();

      for (const foreign of [
        { ...scope, orgId: other.orgId },
        { ...scope, integrationId: other.integrationId, orgId: scope.orgId },
      ]) {
        await expect(
          repository.recordMerchantEvent(foreign, 'not_now'),
        ).rejects.toThrow();
      }
      expect(await stateRow(scope.integrationId)).toBeUndefined();
      expect(await stateRow(other.integrationId)).toBeUndefined();
      await expect(
        repository.findMerchantView(other.orgId, scope.integrationId),
      ).resolves.toEqual({ switchedOn: false, state: undefined });
    });

    it('keeps the state when the event cannot be written', async () => {
      const scope = await enabledStore();

      await expect(
        repository.recordMerchantEvent(
          { ...scope, actorId: FAILING_ACTOR },
          'not_now',
        ),
      ).rejects.toThrow();

      expect(await stateRow(scope.integrationId)).toBeUndefined();
      await expect(
        repository.recordMerchantEvent(scope, 'not_now'),
      ).resolves.toEqual({ outcome: 'recorded' });
    });
  });

  describe('reset', () => {
    it('makes the prompt eligible again and audits it', async () => {
      const scope = await enabledStore();
      await repository.recordMerchantEvent(scope, 'shown');
      await repository.recordMerchantEvent(scope, 'clicked');
      await repository.recordMerchantEvent(scope, 'result', 'cooldown-period');

      await expect(
        repository.reset(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'reset' });

      expect(await stateRow(scope.integrationId)).toMatchObject({
        state: 'eligible',
        snooze_count: 0,
        snoozed_until: null,
        shown_count: 1,
        last_result_code: 'cooldown-period',
      });
      expect((await events(scope.integrationId)).at(-1)).toMatchObject({
        event: 'reset',
        actor_type: 'admin',
        request_id: scope.requestId,
      });
      expect((await auditActions(scope.integrationId)).at(-1)).toBe(
        'store.review-prompt.reset',
      );
    });

    it('resets a store that never answered', async () => {
      const store = await createStore();
      await expect(
        repository.reset(store.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'reset' });
      expect(await stateRow(store.integrationId)).toMatchObject({
        state: 'eligible',
      });
    });

    it('refuses a store that is not on Shopify or unknown', async () => {
      const store = await createStore('standalone');
      await expect(
        repository.reset(store.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'unsupported_platform' });
      await expect(repository.reset(randomUUID(), AUDIT)).resolves.toEqual({
        outcome: 'not_found',
      });
    });
  });

  describe('store results', () => {
    it('counts only outcomes the customer gave on real orders', async () => {
      const store = await createStore();
      await addOutcome(store, { status: 'confirmed' });
      await addOutcome(store, { status: 'confirmed' });
      await addOutcome(store, {
        status: 'confirmed',
        confirmationSource: 'merchant_manual',
      });
      await addOutcome(store, { status: 'confirmed', isTest: true });
      await addOutcome(store, {
        status: 'confirmed',
        externalOrderId: 'akeed-test-onboarding-1',
      });
      await addOutcome(store, { status: 'canceled' });
      await addOutcome(store, {
        status: 'canceled',
        cancellationSource: 'merchant_no_reply',
      });
      await addOutcome(store, {
        status: 'canceled',
        cancellationSource: 'merchant_no_whatsapp',
      });
      await addOutcome(store, { status: 'no_reply' });
      await addOutcome(store, { status: 'sent' });

      await expect(
        repository.countStoreResults(store.orgId, store.integrationId),
      ).resolves.toEqual({
        confirmed: 2,
        canceled: 1,
        since: '2026-01-01T00:00:00.000Z',
      });
    });

    it('counts from the current installation after a reinstall', async () => {
      const store = await createStore();
      await addLifecycle(store, '2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z');
      await addLifecycle(store, '2026-09-03T08:00:00Z', null);
      await addOutcome(store, {
        status: 'confirmed',
        createdAt: '2026-04-01T00:00:00Z',
      });
      await addOutcome(store, {
        status: 'confirmed',
        createdAt: '2026-09-10T00:00:00Z',
      });

      await expect(
        repository.countStoreResults(store.orgId, store.integrationId),
      ).resolves.toEqual({
        confirmed: 1,
        canceled: 0,
        since: '2026-09-03T08:00:00.000Z',
      });
    });

    it('counts nothing from another store or org', async () => {
      const store = await createStore();
      const other = await createStore();
      await addOutcome(other, { status: 'confirmed' });

      await expect(
        repository.countStoreResults(store.orgId, store.integrationId),
      ).resolves.toMatchObject({ confirmed: 0, canceled: 0 });
      await expect(
        repository.countStoreResults(other.orgId, store.integrationId),
      ).resolves.toBeUndefined();
    });
  });

  describe('schema guards', () => {
    it('allows one pending request per store', async () => {
      const scope = await enabledStore();
      await expect(
        client`INSERT INTO review_prompt_requests (org_id, integration_id, enabled_by)
          VALUES (${scope.orgId}, ${scope.integrationId}, ${STAFF})`,
      ).rejects.toMatchObject({
        constraint_name: 'review_prompt_requests_one_pending_idx',
      });
    });

    it('refuses a snoozed state without its end', async () => {
      const store = await createStore();
      await expect(
        client`INSERT INTO review_prompt_states (integration_id, org_id, state)
          VALUES (${store.integrationId}, ${store.orgId}, 'snoozed')`,
      ).rejects.toMatchObject({
        constraint_name: 'review_prompt_states_snooze_check',
      });
    });

    it('refuses an unknown state', async () => {
      const store = await createStore();
      await expect(
        client`INSERT INTO review_prompt_states (integration_id, org_id, state)
          VALUES (${store.integrationId}, ${store.orgId}, 'maybe')`,
      ).rejects.toMatchObject({
        constraint_name: 'review_prompt_states_state_check',
      });
    });
  });
});
