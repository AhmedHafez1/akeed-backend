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
import { REVIEW_PROMPT_MERCHANT_ACTIONS } from '../src/shared/review-prompt/review-prompt.types';

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

const MIGRATION = '0070_review_prompts.sql';
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

async function migrate(): Promise<void> {
  await client.begin(async (tx) => {
    for (const statement of readFileSync(
      resolve(__dirname, '../drizzle', MIGRATION),
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
    INSERT INTO integrations (id, org_id, platform_type, platform_store_url)
    VALUES (${integrationId}, ${orgId}, ${platformType}, ${`${integrationId}.myshopify.com`})`;
  return { orgId, integrationId };
}

async function enabledStore() {
  const store = await createStore();
  const result = await repository.enable(store.integrationId, AUDIT);
  if (result.outcome !== 'created') throw new Error(result.outcome);
  const scope: ReviewPromptMerchantScope = {
    ...store,
    requestId: result.requestId,
    actorId: 'shopify-user-1',
  };
  return scope;
}

async function requestRow(id: string) {
  const [row] = await client<
    { status: string; closed_action: string | null; closed_at: string | null }[]
  >`SELECT status, closed_action, closed_at FROM review_prompt_requests WHERE id = ${id}`;
  return row;
}

async function events(requestId: string) {
  return client<{ event: string; actor_type: string; actor_id: string }[]>`
    SELECT event, actor_type, actor_id FROM review_prompt_events
    WHERE request_id = ${requestId} ORDER BY created_at, event`;
}

async function auditActions(integrationId: string) {
  const rows = await client<{ action: string }[]>`
    SELECT action FROM admin_access_audit
    WHERE target_integration_id = ${integrationId} ORDER BY created_at`;
  return rows.map((row) => row.action);
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
    `);
    await migrate();
    // Applying it twice proves the migration re-runs cleanly.
    await migrate();
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
      const requestId = (first as { requestId: string }).requestId;
      expect(await requestRow(requestId)).toMatchObject({ status: 'pending' });
      expect(await events(requestId)).toEqual([
        { event: 'enabled', actor_type: 'admin', actor_id: STAFF },
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
      const [{ count }] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM review_prompt_requests
        WHERE integration_id = ${store.integrationId}`;
      expect(count).toBe(1);
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

    it('closes the pending request and audits the switch-off', async () => {
      const scope = await enabledStore();

      await expect(
        repository.disable(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'disabled' });
      await expect(
        repository.disable(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'not_pending' });

      expect(await requestRow(scope.requestId)).toMatchObject({
        status: 'admin_disabled',
        closed_action: 'admin_disabled',
      });
      expect((await events(scope.requestId)).map((e) => e.event)).toEqual([
        'enabled',
        'admin_disabled',
      ]);
      expect(await auditActions(scope.integrationId)).toEqual([
        'store.review-prompt.enable',
        'store.review-prompt.disable',
      ]);
      await expect(
        repository.recordMerchantAction(scope, 'snoozed'),
      ).resolves.toEqual({ outcome: 'conflict' });
    });
  });

  describe('merchant answers', () => {
    it.each(REVIEW_PROMPT_MERCHANT_ACTIONS)(
      '%s closes the request and records one event in the same transaction',
      async (action) => {
        const scope = await enabledStore();

        await expect(
          repository.recordMerchantAction(scope, action),
        ).resolves.toEqual({ outcome: 'recorded' });

        expect(await requestRow(scope.requestId)).toMatchObject({
          status: 'answered',
          closed_action: action,
        });
        expect(await events(scope.requestId)).toContainEqual({
          event: action,
          actor_type: 'merchant',
          actor_id: 'shopify-user-1',
        });
        await expect(
          repository.findPending(scope.orgId, scope.integrationId),
        ).resolves.toBeUndefined();
      },
    );

    it('replays a duplicate submission without a second event', async () => {
      const scope = await enabledStore();

      await repository.recordMerchantAction(scope, 'snoozed');
      await expect(
        repository.recordMerchantAction(scope, 'snoozed'),
      ).resolves.toEqual({ outcome: 'replayed' });
      await expect(
        repository.recordMerchantAction(scope, 'dismissed'),
      ).resolves.toEqual({ outcome: 'conflict' });

      expect((await events(scope.requestId)).map((e) => e.event)).toEqual([
        'enabled',
        'snoozed',
      ]);
    });

    it('records one answer when the same answer arrives concurrently', async () => {
      const scope = await enabledStore();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.recordMerchantAction(scope, 'dismissed'),
        ),
      );

      expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'replayed')).toHaveLength(3);
      expect(
        (await events(scope.requestId)).filter((e) => e.event === 'dismissed'),
      ).toHaveLength(1);
    });

    it('never touches a request from another store or org', async () => {
      const scope = await enabledStore();
      const other = await createStore();

      for (const foreign of [
        { ...scope, orgId: other.orgId },
        { ...scope, integrationId: other.integrationId },
        { ...scope, ...other },
      ]) {
        await expect(
          repository.recordMerchantAction(foreign, 'dont_ask_again'),
        ).resolves.toEqual({ outcome: 'not_found' });
        await expect(repository.recordShown(foreign)).resolves.toEqual({
          outcome: 'not_found',
        });
      }
      expect(await requestRow(scope.requestId)).toMatchObject({
        status: 'pending',
      });
      await expect(
        repository.findPending(other.orgId, scope.integrationId),
      ).resolves.toBeUndefined();
    });

    it('keeps the request pending when the event cannot be written', async () => {
      const scope = await enabledStore();

      await expect(
        repository.recordMerchantAction(
          { ...scope, actorId: FAILING_ACTOR },
          'snoozed',
        ),
      ).rejects.toThrow();

      expect(await requestRow(scope.requestId)).toMatchObject({
        status: 'pending',
        closed_action: null,
      });
      expect((await events(scope.requestId)).map((e) => e.event)).toEqual([
        'enabled',
      ]);
      await expect(
        repository.recordMerchantAction(scope, 'snoozed'),
      ).resolves.toEqual({ outcome: 'recorded' });
    });
  });

  describe('impressions', () => {
    it('records the first impression once and none after an answer', async () => {
      const scope = await enabledStore();

      await expect(repository.recordShown(scope)).resolves.toEqual({
        outcome: 'recorded',
      });
      await expect(repository.recordShown(scope)).resolves.toEqual({
        outcome: 'replayed',
      });
      await repository.recordMerchantAction(scope, 'review_clicked');
      await expect(repository.recordShown(scope)).resolves.toEqual({
        outcome: 'not_pending',
      });

      expect((await events(scope.requestId)).map((e) => e.event)).toEqual([
        'enabled',
        'shown',
        'review_clicked',
      ]);
    });

    it('leaves an unanswered request pending for the next visit', async () => {
      const scope = await enabledStore();
      await repository.recordShown(scope);
      await expect(
        repository.findPending(scope.orgId, scope.integrationId),
      ).resolves.toEqual({ id: scope.requestId });
    });
  });

  describe('opt-out and re-enabling', () => {
    it('blocks every later request after "Don\'t ask again"', async () => {
      const scope = await enabledStore();
      await repository.recordMerchantAction(scope, 'dont_ask_again');

      await expect(
        repository.enable(scope.integrationId, AUDIT),
      ).resolves.toEqual({ outcome: 'opted_out' });

      const state = await repository.findAdminState(scope.integrationId);
      expect(state?.pending).toBeNull();
      expect(state?.optedOutAt).not.toBeNull();
      expect(state?.events[0]).toMatchObject({ event: 'dont_ask_again' });
    });

    it.each(['snoozed', 'dismissed', 'review_clicked'] as const)(
      'needs a new staff switch-on after %s',
      async (action) => {
        const scope = await enabledStore();
        await repository.recordMerchantAction(scope, action);

        await expect(
          repository.findPending(scope.orgId, scope.integrationId),
        ).resolves.toBeUndefined();
        const next = await repository.enable(scope.integrationId, AUDIT);
        expect(next.outcome).toBe('created');
        expect((next as { requestId: string }).requestId).not.toBe(
          scope.requestId,
        );
      },
    );
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

    it('allows one answer per request', async () => {
      const scope = await enabledStore();
      await repository.recordMerchantAction(scope, 'snoozed');
      await expect(
        client`INSERT INTO review_prompt_events (request_id, org_id, integration_id, event, actor_type)
          VALUES (${scope.requestId}, ${scope.orgId}, ${scope.integrationId}, 'dismissed', 'merchant')`,
      ).rejects.toMatchObject({
        constraint_name: 'review_prompt_events_one_answer_idx',
      });
    });

    it('refuses a closed request without its closing answer', async () => {
      const scope = await enabledStore();
      await expect(
        client`UPDATE review_prompt_requests SET status = 'answered' WHERE id = ${scope.requestId}`,
      ).rejects.toMatchObject({
        constraint_name: 'review_prompt_requests_closed_check',
      });
    });
  });
});
