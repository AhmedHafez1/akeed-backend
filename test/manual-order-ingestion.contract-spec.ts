import { randomUUID } from 'node:crypto';
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
});
