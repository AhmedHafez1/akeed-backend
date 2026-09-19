import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database';
import {
  ManualOrderAcceptanceStateError,
  ManualOrderIngestionRepository,
  ManualOrderPayloadConflictError,
  type ManualOrderAcceptanceInput,
} from '../src/infrastructure/database/repositories/manual-order-ingestion.repository';
import { OrdersRepository } from '../src/infrastructure/database/repositories/orders.repository';
import { WebhookEventsRepository } from '../src/infrastructure/database/repositories/webhook-events.repository';

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

const namespace = `e04_manual_order_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const database = drizzle(client, { schema });
const repository = new ManualOrderIngestionRepository(database);
const dashboardRepository = new OrdersRepository(database);
const eventsRepository = new WebhookEventsRepository(database);
let created = false;

function acceptanceInput(
  orgId: string,
  integrationId: string,
  key: string,
  fingerprint = 'fingerprint-a',
): ManualOrderAcceptanceInput {
  const rawPayload = {
    ingestionType: 'manual',
    schemaVersion: 1,
    submissionFingerprint: fingerprint,
    order: {
      customerPhone: '+201001234567',
      customerName: 'Customer',
      orderNumber: `ORDER-${key}`,
      totalPrice: '125.50',
    },
  };
  return {
    event: {
      idempotencyKey: key,
      storeDomain: `standalone:${orgId}`,
      orgId,
      integrationId,
      rawPayload,
      submissionFingerprint: fingerprint,
    },
    order: {
      orgId,
      integrationId,
      externalOrderId: `manual-${key}`,
      orderNumber: `ORDER-${key}`,
      customerPhone: '+201001234567',
      customerName: 'Customer',
      totalPrice: '125.50',
      currency: 'EGP',
      paymentMethod: 'cash_on_delivery',
      rawPayload,
      isTest: false,
    },
  };
}

async function createSource(): Promise<{
  orgId: string;
  integrationId: string;
}> {
  const orgId = randomUUID();
  const integrationId = randomUUID();
  await client`
    INSERT INTO organizations (id, name, slug)
    VALUES (${orgId}, 'Manual order contract', ${`manual-${orgId}`})
  `;
  await client`
    INSERT INTO integrations (id, org_id, platform_type, platform_store_url)
    VALUES (${integrationId}, ${orgId}, 'standalone', ${`standalone:${orgId}`})
  `;
  return { orgId, integrationId };
}

describe('manual order ingestion PostgreSQL contract', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      CREATE TYPE webhook_event_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'skipped');
      CREATE TYPE verification_status AS ENUM ('pending', 'sent', 'delivered', 'read', 'confirmed', 'canceled', 'expired', 'failed', 'no_reply');
      CREATE TYPE verification_dispatch_kind AS ENUM ('initial', 'follow_up', 'legacy_unknown');
      CREATE TYPE verification_dispatch_state AS ENUM ('ready', 'sending', 'accepted', 'rejected', 'outcome_unknown');
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
      CREATE TABLE orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        integration_id uuid NOT NULL,
        external_order_id text NOT NULL,
        order_number text,
        customer_phone text NOT NULL,
        customer_name text,
        customer_email text,
        total_price numeric(12,2),
        currency text DEFAULT 'SAR',
        payment_method text,
        raw_payload jsonb,
        is_test boolean DEFAULT false NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        FOREIGN KEY (integration_id, org_id) REFERENCES integrations(id, org_id),
        UNIQUE (integration_id, external_order_id),
        UNIQUE (id, org_id)
      );
      CREATE TABLE webhook_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        platform text NOT NULL,
        job_type text NOT NULL,
        idempotency_key text NOT NULL,
        store_domain text NOT NULL,
        org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
        integration_id uuid,
        order_id uuid,
        status webhook_event_status DEFAULT 'pending' NOT NULL,
        raw_payload jsonb NOT NULL,
        dispatch_required boolean DEFAULT false NOT NULL,
        dispatch_attempts integer DEFAULT 0 NOT NULL,
        last_dispatch_error text,
        next_dispatch_at timestamptz,
        dispatch_lease_until timestamptz,
        dispatched_at timestamptz,
        processing_lease_until timestamptz,
        attempts integer DEFAULT 0 NOT NULL,
        last_error text,
        processed_at timestamptz,
        received_at timestamptz DEFAULT now(),
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        FOREIGN KEY (integration_id, org_id) REFERENCES integrations(id, org_id),
        FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id),
        UNIQUE (order_id),
        UNIQUE (platform, store_domain, idempotency_key),
        CHECK ((org_id IS NULL) = (integration_id IS NULL))
      );
      CREATE TABLE verifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        order_id uuid NOT NULL UNIQUE,
        status verification_status DEFAULT 'pending',
        wa_message_id text,
        template_name text DEFAULT 'cod_verification',
        language_code text DEFAULT 'ar',
        attempts integer DEFAULT 0,
        last_sent_at timestamptz,
        next_retry_at timestamptz,
        confirmed_at timestamptz,
        canceled_at timestamptz,
        delivered_at timestamptz,
        read_at timestamptz,
        expired_at timestamptz,
        follow_up_sent_at timestamptz,
        no_reply_at timestamptz,
        follow_up_attempts integer DEFAULT 0 NOT NULL,
        merchant_canceled_at timestamptz,
        cancellation_source text,
        metadata jsonb DEFAULT '{}'::jsonb,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        FOREIGN KEY (order_id, org_id) REFERENCES orders(id, org_id),
        UNIQUE (id, org_id)
      );
      CREATE TABLE verification_message_dispatches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        integration_id uuid NOT NULL,
        verification_id uuid NOT NULL,
        dispatch_key text NOT NULL UNIQUE,
        generation integer NOT NULL DEFAULT 1,
        kind verification_dispatch_kind NOT NULL,
        state verification_dispatch_state DEFAULT 'ready' NOT NULL,
        sender_kind text DEFAULT 'akeed_system' NOT NULL,
        template_name text,
        language_code text,
        provider_message_id text,
        usage_period_start date,
        usage_reserved boolean DEFAULT false NOT NULL,
        attempt_count integer DEFAULT 0 NOT NULL,
        last_error_code text,
        lease_until timestamptz,
        accepted_at timestamptz,
        delivered_at timestamptz,
        read_at timestamptz,
        failed_at timestamptz,
        resolved_at timestamptz,
        metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        FOREIGN KEY (verification_id, org_id) REFERENCES verifications(id, org_id) ON DELETE CASCADE,
        FOREIGN KEY (integration_id, org_id) REFERENCES integrations(id, org_id)
      );
    `);
    // Layer the real hold migration on the hand-written base so this suite
    // exercises the shipped columns and constraints, not a copy of them.
    for (const statement of readFileSync(
      resolve(__dirname, '../drizzle/0036_webhook_event_hold.sql'),
      'utf8',
    ).split('--> statement-breakpoint')) {
      if (statement.trim()) await client.unsafe(statement);
    }
  });

  afterAll(async () => {
    try {
      if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('allows one durable winner and replays the same result under concurrency', async () => {
    const { orgId, integrationId } = await createSource();
    const input = acceptanceInput(
      orgId,
      integrationId,
      'concurrent-submission',
    );
    const results = await Promise.all([
      repository.accept(input),
      repository.accept(input),
      repository.accept(input),
      repository.accept(input),
    ]);

    expect(new Set(results.map(({ eventId }) => eventId))).toHaveProperty(
      'size',
      1,
    );
    expect(new Set(results.map(({ order }) => order.id))).toHaveProperty(
      'size',
      1,
    );
    expect(results.filter(({ duplicate }) => !duplicate)).toHaveLength(1);
    expect(results.filter(({ duplicate }) => duplicate)).toHaveLength(3);

    const [counts] = await client<
      { events: number; orders: number; dispatch_required: boolean }[]
    >`
      SELECT
        (SELECT count(*)::int FROM webhook_events WHERE org_id = ${orgId}) AS events,
        (SELECT count(*)::int FROM orders WHERE org_id = ${orgId}) AS orders,
        (SELECT dispatch_required FROM webhook_events WHERE org_id = ${orgId}) AS dispatch_required
    `;
    expect(counts).toEqual({
      events: 1,
      orders: 1,
      dispatch_required: true,
    });
  });

  it('rejects changed content for the same source key without mutation', async () => {
    const { orgId, integrationId } = await createSource();
    const key = 'changed-content';
    await repository.accept(
      acceptanceInput(orgId, integrationId, key, 'fingerprint-a'),
    );
    await expect(
      repository.accept(
        acceptanceInput(orgId, integrationId, key, 'fingerprint-b'),
      ),
    ).rejects.toBeInstanceOf(ManualOrderPayloadConflictError);

    await expect(
      client`
        SELECT
          (SELECT count(*)::int FROM webhook_events WHERE org_id = ${orgId}) AS events,
          (SELECT count(*)::int FROM orders WHERE org_id = ${orgId}) AS orders
      `,
    ).resolves.toEqual([{ events: 1, orders: 1 }]);
  });

  it('rolls back the durable event when order creation fails', async () => {
    const { orgId, integrationId } = await createSource();
    const key = 'rollback-submission';
    await client.unsafe(`
      CREATE FUNCTION reject_manual_order() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected order failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_manual_order_trigger
      BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION reject_manual_order();
    `);

    try {
      await repository.accept(acceptanceInput(orgId, integrationId, key));
      throw new Error('Expected injected order failure');
    } catch (error) {
      expect((error as { cause?: { message?: string } }).cause?.message).toBe(
        'injected order failure',
      );
    } finally {
      await client`DROP TRIGGER reject_manual_order_trigger ON orders`;
      await client`DROP FUNCTION reject_manual_order()`;
    }

    await expect(
      client`SELECT id FROM webhook_events WHERE idempotency_key = ${key}`,
    ).resolves.toHaveLength(0);
    await expect(
      client`SELECT id FROM orders WHERE org_id = ${orgId}`,
    ).resolves.toHaveLength(0);
  });

  it('scopes the same retry key independently to each trusted source', async () => {
    const sourceA = await createSource();
    const sourceB = await createSource();
    const key = 'tenant-scoped-key';
    const [acceptedA, acceptedB] = await Promise.all([
      repository.accept(
        acceptanceInput(sourceA.orgId, sourceA.integrationId, key),
      ),
      repository.accept(
        acceptanceInput(sourceB.orgId, sourceB.integrationId, key),
      ),
    ]);

    expect(acceptedA.duplicate).toBe(false);
    expect(acceptedB.duplicate).toBe(false);
    expect(acceptedA.order.orgId).toBe(sourceA.orgId);
    expect(acceptedB.order.orgId).toBe(sourceB.orgId);
    await expect(
      client`SELECT id FROM orders WHERE org_id = ${sourceA.orgId}`,
    ).resolves.toHaveLength(1);
    await expect(
      client`SELECT id FROM orders WHERE org_id = ${sourceB.orgId}`,
    ).resolves.toHaveLength(1);
  });

  it('fails closed when a stored event has mismatched source ownership', async () => {
    const sourceA = await createSource();
    const sourceB = await createSource();
    const key = 'mismatched-source';
    const input = acceptanceInput(sourceA.orgId, sourceA.integrationId, key);
    await client`
      INSERT INTO webhook_events (
        platform,
        job_type,
        idempotency_key,
        store_domain,
        org_id,
        integration_id,
        raw_payload,
        dispatch_required
      )
      VALUES (
        'standalone',
        'order.create',
        ${key},
        ${input.event.storeDomain},
        ${sourceB.orgId},
        ${sourceB.integrationId},
        ${JSON.stringify(input.event.rawPayload)}::jsonb,
        true
      )
    `;

    await expect(repository.accept(input)).rejects.toBeInstanceOf(
      ManualOrderAcceptanceStateError,
    );
    await expect(
      client`SELECT id FROM orders WHERE org_id = ${sourceA.orgId}`,
    ).resolves.toHaveLength(0);
  });

  it('projects tenant-scoped retry-guard state for every order shape', async () => {
    // The dashboard list no longer speaks these states — it renders only the
    // nine `verification_status` values. They survive here because retry
    // safety still needs them: a queued order must not read as a failure, and
    // an unresolved dispatch must block a re-send.
    const sourceA = await createSource();
    const sourceB = await createSource();
    const specifications: Array<{
      key: string;
      eventStatus:
        | 'pending'
        | 'processing'
        | 'completed'
        | 'failed'
        | 'skipped';
      reason: string | null;
      verificationStatus?: 'confirmed' | 'failed' | 'no_reply';
      expectedStatus: string;
      expectedRetryable: boolean;
    }> = [
      {
        key: 'accepted',
        eventStatus: 'pending',
        reason: null,
        expectedStatus: 'accepted',
        expectedRetryable: false,
      },
      {
        key: 'processing',
        eventStatus: 'processing',
        reason: null,
        expectedStatus: 'processing',
        expectedRetryable: false,
      },
      {
        key: 'ineligible',
        eventStatus: 'skipped',
        reason: 'non_cod_payment_method',
        expectedStatus: 'ineligible',
        expectedRetryable: false,
      },
      {
        key: 'blocked',
        eventStatus: 'skipped',
        reason: 'plan_limit_reached',
        expectedStatus: 'blocked',
        expectedRetryable: true,
      },
      {
        key: 'confirmed',
        eventStatus: 'completed',
        reason: null,
        verificationStatus: 'confirmed',
        expectedStatus: 'confirmed',
        expectedRetryable: false,
      },
      {
        key: 'review',
        eventStatus: 'completed',
        reason: null,
        verificationStatus: 'failed',
        expectedStatus: 'review_required',
        expectedRetryable: false,
      },
    ];

    const orderIds = new Map<string, string>();
    for (const specification of specifications) {
      const accepted = await repository.accept(
        acceptanceInput(
          sourceA.orgId,
          sourceA.integrationId,
          `retry-guard-${specification.key}`,
        ),
      );
      orderIds.set(specification.key, accepted.order.id);
      await client`
        UPDATE webhook_events
        SET status = ${specification.eventStatus}::webhook_event_status,
            last_error = ${specification.reason}
        WHERE id = ${accepted.eventId}
      `;

      if (specification.verificationStatus) {
        const [verification] = await client<{ id: string }[]>`
          INSERT INTO verifications (org_id, order_id, status, metadata)
          VALUES (
            ${sourceA.orgId},
            ${accepted.order.id},
            ${specification.verificationStatus}::verification_status,
            ${JSON.stringify(
              specification.key === 'review'
                ? { reason: 'provider_outcome_unknown' }
                : {},
            )}::jsonb
          )
          RETURNING id
        `;
        if (specification.key === 'review') {
          await client`
            INSERT INTO verification_message_dispatches (
              org_id, integration_id, verification_id, dispatch_key, kind, state
            )
            VALUES (
              ${sourceA.orgId},
              ${sourceA.integrationId},
              ${verification.id},
              'retry-guard-review-dispatch',
              'initial',
              'outcome_unknown'
            )
          `;
        }
      }
    }

    for (const specification of specifications) {
      const row = await dashboardRepository.findDashboardOrderById(
        orderIds.get(specification.key)!,
        sourceA.orgId,
      );
      expect(row?.retryGuardStatus).toBe(specification.expectedStatus);
      expect(row?.retryGuardRetryable).toBe(specification.expectedRetryable);
    }

    // Another tenant asking for the same order id gets nothing back.
    await expect(
      dashboardRepository.findDashboardOrderById(
        orderIds.get('accepted')!,
        sourceB.orgId,
      ),
    ).resolves.toBeUndefined();
  });

  describe('webhook event hold (US-04.6-01)', () => {
    const maxAttempts = 8;
    const farFuture = '2999-01-01T00:00:00.000Z';

    async function acceptHeld(
      source: { orgId: string; integrationId: string },
      key: string,
      groupId: string,
    ) {
      const input = acceptanceInput(source.orgId, source.integrationId, key);
      return repository.accept({
        ...input,
        event: { ...input.event, hold: { groupId } },
      });
    }

    async function eventRow(id: string) {
      const [row] = await client<
        {
          hold_state: string;
          hold_group_id: string | null;
          status: string;
          dispatch_required: boolean;
          next_dispatch_at: string | null;
          held_at: string | null;
          released_at: string | null;
          withdrawn_at: string | null;
          last_error: string | null;
        }[]
      >`
        SELECT hold_state, hold_group_id, status, dispatch_required,
               next_dispatch_at, held_at, released_at, withdrawn_at, last_error
        FROM webhook_events WHERE id = ${id}
      `;
      return row;
    }

    async function recoverableIds(): Promise<Set<string>> {
      const rows = await eventsRepository.findRecoverable(
        1000,
        new Date().toISOString(),
        maxAttempts,
      );
      return new Set(rows.map(({ id }) => id));
    }

    it('persists a held event that is not dispatchable', async () => {
      const source = await createSource();
      const groupId = randomUUID();
      const accepted = await acceptHeld(source, 'hold-persist', groupId);

      expect(await eventRow(accepted.eventId)).toMatchObject({
        hold_state: 'held',
        hold_group_id: groupId,
        status: 'pending',
        dispatch_required: false,
        next_dispatch_at: null,
        held_at: expect.any(String) as unknown,
        released_at: null,
        withdrawn_at: null,
      });
      // Replaying the same held submission is a duplicate, not a second order.
      await expect(
        acceptHeld(source, 'hold-persist', groupId),
      ).resolves.toMatchObject({ eventId: accepted.eventId, duplicate: true });
    });

    it('defaults every other event to none and keeps it dispatchable', async () => {
      const source = await createSource();
      const accepted = await repository.accept(
        acceptanceInput(source.orgId, source.integrationId, 'hold-none'),
      );

      expect(await eventRow(accepted.eventId)).toMatchObject({
        hold_state: 'none',
        dispatch_required: true,
      });
      expect(await recoverableIds()).toContain(accepted.eventId);
    });

    it('refuses to store a held event marked dispatchable', async () => {
      const source = await createSource();
      const accepted = await acceptHeld(source, 'hold-check', randomUUID());

      await expect(
        client`UPDATE webhook_events SET dispatch_required = true WHERE id = ${accepted.eventId}`,
      ).rejects.toMatchObject({
        constraint_name: 'webhook_events_held_not_dispatchable_check',
      });
      await expect(
        client`UPDATE webhook_events SET hold_state = 'paused' WHERE id = ${accepted.eventId}`,
      ).rejects.toMatchObject({
        constraint_name: 'webhook_events_hold_state_check',
      });
    });

    it('never offers held or withdrawn events to dispatch, recovery or retry', async () => {
      const source = await createSource();
      const held = await acceptHeld(source, 'hold-excluded', randomUUID());
      const withdrawn = await acceptHeld(
        source,
        'withdrawn-excluded',
        randomUUID(),
      );
      await eventsRepository.withdrawHeld(source.orgId, {
        eventIds: [withdrawn.eventId],
      });
      // The mistake the predicate must survive: a withdrawn row forced back
      // into a dispatchable shape.
      await client`
        UPDATE webhook_events
        SET status = 'pending', dispatch_required = true, next_dispatch_at = NOW() - interval '1 minute'
        WHERE id = ${withdrawn.eventId}
      `;

      const recoverable = await recoverableIds();
      expect(recoverable).not.toContain(held.eventId);
      expect(recoverable).not.toContain(withdrawn.eventId);
      for (const eventId of [held.eventId, withdrawn.eventId]) {
        await expect(
          eventsRepository.claimForDispatch(
            eventId,
            farFuture,
            new Date().toISOString(),
            maxAttempts,
          ),
        ).resolves.toBeNull();
      }

      const orphans = await eventsRepository.findOrdersMissingVerification(
        1000,
        farFuture,
      );
      expect(orphans.map(({ eventId }) => eventId)).not.toContain(held.eventId);

      await client`UPDATE webhook_events SET status = 'skipped' WHERE id = ${withdrawn.eventId}`;
      await expect(
        eventsRepository.resetForRedispatch({
          id: withdrawn.eventId,
          orderId: withdrawn.order.id,
        }),
      ).resolves.toBe(false);
    });

    it('still re-drives ordinary events through the orphan sweep and retry reset', async () => {
      const source = await createSource();
      const accepted = await repository.accept(
        acceptanceInput(source.orgId, source.integrationId, 'hold-control'),
      );
      const orphans = await eventsRepository.findOrdersMissingVerification(
        1000,
        farFuture,
      );
      expect(orphans.map(({ eventId }) => eventId)).toContain(accepted.eventId);

      await client`UPDATE webhook_events SET status = 'skipped' WHERE id = ${accepted.eventId}`;
      await expect(
        eventsRepository.resetForRedispatch({
          id: accepted.eventId,
          orderId: accepted.order.id,
        }),
      ).resolves.toBe(true);
    });

    it('releases held events once, only for their own organization', async () => {
      const source = await createSource();
      const other = await createSource();
      const groupId = randomUUID();
      const first = await acceptHeld(source, 'release-1', groupId);
      const second = await acceptHeld(source, 'release-2', groupId);
      const dispatchAt = new Date(Date.now() - 1000).toISOString();

      await expect(
        eventsRepository.releaseHeld(other.orgId, [first.eventId], dispatchAt),
      ).resolves.toEqual([]);
      await expect(
        eventsRepository.releaseHeld(source.orgId, [first.eventId], dispatchAt),
      ).resolves.toEqual([first.eventId]);
      await expect(
        eventsRepository.releaseHeld(
          source.orgId,
          [first.eventId, second.eventId],
          dispatchAt,
        ),
      ).resolves.toEqual([second.eventId]);
      await expect(
        eventsRepository.releaseHeld(
          source.orgId,
          [first.eventId, second.eventId],
          dispatchAt,
        ),
      ).resolves.toEqual([]);
      await expect(
        eventsRepository.releaseHeld(source.orgId, [], dispatchAt),
      ).resolves.toEqual([]);

      const released = await eventRow(first.eventId);
      expect(released).toMatchObject({
        hold_state: 'released',
        dispatch_required: true,
        released_at: expect.any(String) as unknown,
        withdrawn_at: null,
      });
      expect(new Date(released.next_dispatch_at!).toISOString()).toBe(
        dispatchAt,
      );
      expect(await recoverableIds()).toContain(first.eventId);
    });

    it('withdraws only held events, by group or by id, and finally', async () => {
      const source = await createSource();
      const groupId = randomUUID();
      const otherGroup = randomUUID();
      const released = await acceptHeld(source, 'withdraw-released', groupId);
      const heldA = await acceptHeld(source, 'withdraw-a', groupId);
      const heldB = await acceptHeld(source, 'withdraw-b', groupId);
      const elsewhere = await acceptHeld(source, 'withdraw-other', otherGroup);
      await eventsRepository.releaseHeld(
        source.orgId,
        [released.eventId],
        new Date().toISOString(),
      );

      const withdrawn = await eventsRepository.withdrawHeld(source.orgId, {
        groupId,
      });
      expect(withdrawn.sort()).toEqual([heldA.eventId, heldB.eventId].sort());
      expect(await eventRow(heldA.eventId)).toMatchObject({
        hold_state: 'withdrawn',
        status: 'skipped',
        last_error: 'import_not_started',
        dispatch_required: false,
        withdrawn_at: expect.any(String) as unknown,
      });
      // Withdraw after release is a no-op; the released order carries on.
      expect(await eventRow(released.eventId)).toMatchObject({
        hold_state: 'released',
        dispatch_required: true,
      });
      expect(await eventRow(elsewhere.eventId)).toMatchObject({
        hold_state: 'held',
      });
      // Release after withdraw is a no-op too.
      await expect(
        eventsRepository.releaseHeld(
          source.orgId,
          [heldA.eventId],
          new Date().toISOString(),
        ),
      ).resolves.toEqual([]);
      await expect(
        eventsRepository.withdrawHeld(source.orgId, {
          eventIds: [elsewhere.eventId],
        }),
      ).resolves.toEqual([elsewhere.eventId]);
    });

    it('lets exactly one of a concurrent release and withdraw win', async () => {
      const source = await createSource();
      const groupId = randomUUID();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const held = await acceptHeld(source, `race-${attempt}`, groupId);
        const [released, withdrawn] = await Promise.all([
          eventsRepository.releaseHeld(
            source.orgId,
            [held.eventId],
            new Date().toISOString(),
          ),
          eventsRepository.withdrawHeld(source.orgId, {
            eventIds: [held.eventId],
          }),
        ]);

        expect(released.length + withdrawn.length).toBe(1);
        const row = await eventRow(held.eventId);
        expect(row.hold_state).toBe(
          released.length === 1 ? 'released' : 'withdrawn',
        );
        expect(row.released_at === null).toBe(released.length === 0);
        expect(row.withdrawn_at === null).toBe(withdrawn.length === 0);
      }
    });

    it('projects every hold state onto the lifecycle', async () => {
      const source = await createSource();
      const groupId = randomUUID();
      const none = await repository.accept(
        acceptanceInput(source.orgId, source.integrationId, 'project-none'),
      );
      const held = await acceptHeld(source, 'project-held', groupId);
      const released = await acceptHeld(source, 'project-released', groupId);
      const releasedProcessing = await acceptHeld(
        source,
        'project-released-processing',
        groupId,
      );
      const withdrawn = await acceptHeld(source, 'project-withdrawn', groupId);
      await eventsRepository.releaseHeld(
        source.orgId,
        [released.eventId, releasedProcessing.eventId],
        new Date().toISOString(),
      );
      await client`UPDATE webhook_events SET status = 'processing' WHERE id = ${releasedProcessing.eventId}`;
      await eventsRepository.withdrawHeld(source.orgId, {
        eventIds: [withdrawn.eventId],
      });

      const expectations: Array<
        [{ order: { id: string } }, string, string | null]
      > = [
        [none, 'accepted', null],
        [held, 'awaiting_start', null],
        [released, 'accepted', null],
        [releasedProcessing, 'processing', null],
        [withdrawn, 'not_started', 'import_not_started'],
      ];
      for (const [accepted, status, reason] of expectations) {
        await expect(
          dashboardRepository.findDashboardOrderById(
            accepted.order.id,
            source.orgId,
          ),
        ).resolves.toMatchObject({
          retryGuardStatus: status,
          retryGuardReason: reason,
          retryGuardRetryable: false,
        });
      }
    });
  });
});
