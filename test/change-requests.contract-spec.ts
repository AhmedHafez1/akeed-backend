import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../src/infrastructure/database/schema';
import * as schema from '../src/infrastructure/database';
import { VerificationChangeRequestsRepository } from '../src/infrastructure/database/repositories/verification-change-requests.repository';
import { VerificationAutoCancellationsRepository } from '../src/infrastructure/database/repositories/verification-auto-cancellations.repository';
import { VerificationsRepository } from '../src/infrastructure/database/repositories/verifications.repository';
import { VerificationMessageDispatchesRepository } from '../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { AutoCancellationService } from '../src/modules/auto-cancellation/auto-cancellation.service';
import { usageAccountingFixture } from './contracts/usage-accounting-fixture';

/**
 * Change requests over PostgreSQL: migration 0092 and its defaults, one open
 * request under concurrent taps, tenant and message binding, the customer and
 * merchant resolutions, reconfirmation, and the guards that keep the no-reply
 * escalation, the reminder and the automatic cancellation away from an order
 * whose customer asked for a change.
 */

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
  )
    throw new Error(
      'NOT RUN: use local PostgreSQL, user e01_test, database akeed_e01_test, without query parameters.',
    );
  return value;
}

const namespace = `change_requests_${randomUUID().replaceAll('-', '')}`;
const client = postgres(isolatedDatabaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: () => undefined,
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema });
const repo = new VerificationChangeRequestsRepository(db as never);
const verificationsRepo = new VerificationsRepository(db as never);
const autoCancelRepo = new VerificationAutoCancellationsRepository(db as never);
const dispatches = new VerificationMessageDispatchesRepository(
  db as never,
  usageAccountingFixture(),
);

async function scaffold(table: PgTable) {
  const definition = getTableConfig(table);
  const dialect = new PgDialect();
  const columns = definition.columns.map((column) => {
    let result = `"${column.name}" ${column.getSQLType()}`;
    if (column.notNull) result += ' NOT NULL';
    if (column.primary) result += ' PRIMARY KEY';
    if (column.default !== undefined) {
      const value = column.default;
      result +=
        ' DEFAULT ' +
        (value instanceof SQL
          ? dialect.sqlToQuery(value).sql
          : typeof value === 'boolean' || typeof value === 'number'
            ? String(value)
            : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll("'", "''")}'`);
    }
    return result;
  });
  for (const unique of definition.uniqueConstraints)
    columns.push(
      `CONSTRAINT "${unique.name}" UNIQUE (${unique.columns.map((column) => `"${column.name}"`).join(', ')})`,
    );
  await client.unsafe(
    `CREATE TABLE "${definition.name}" (${columns.join(', ')})`,
  );
}

async function migrate(name: string) {
  const statements = readFileSync(
    resolve(__dirname, '../drizzle', name),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((part) => part.trim());
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

const orgA = randomUUID();
const orgB = randomUUID();
const integrationA = randomUUID();
const integrationB = randomUUID();
const legacyVerificationId = randomUUID();
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Seeded {
  verificationId: string;
  orderId: string;
  wamid: string;
  dispatchId: string;
}

/** An order awaiting the customer, with its accepted confirmation message. */
async function seed(
  overrides: {
    orgId?: string;
    integrationId?: string;
    verification?: Partial<typeof tables.verifications.$inferInsert>;
    dispatch?: Partial<
      typeof tables.verificationMessageDispatches.$inferInsert
    >;
    isTest?: boolean;
  } = {},
): Promise<Seeded> {
  const orgId = overrides.orgId ?? orgA;
  const integrationId = overrides.integrationId ?? integrationA;
  const orderId = randomUUID();
  const verificationId = randomUUID();
  const dispatchId = randomUUID();
  const wamid = `wamid.${randomUUID()}`;
  await db.insert(tables.orders).values({
    id: orderId,
    orgId,
    integrationId,
    externalOrderId: `ext-${orderId}`,
    orderNumber: '1001',
    // The same customer buys from both stores.
    customerPhone: '+201000000001',
    customerName: 'Customer',
    totalPrice: '100.00',
    currency: 'EGP',
    isTest: overrides.isTest ?? false,
  });
  await db.insert(tables.verifications).values({
    id: verificationId,
    orgId,
    orderId,
    status: 'delivered',
    waMessageId: wamid,
    lastSentAt: ago(2 * HOUR),
    deliveredAt: ago(2 * HOUR),
    ...overrides.verification,
  });
  await db.insert(tables.verificationMessageDispatches).values({
    id: dispatchId,
    orgId,
    integrationId,
    verificationId,
    dispatchKey: `${verificationId}:initial:1`,
    kind: 'initial',
    state: 'accepted',
    providerMessageId: wamid,
    acceptedAt: ago(2 * HOUR),
    deliveredAt: ago(2 * HOUR),
    ...overrides.dispatch,
  });
  return { verificationId, orderId, wamid, dispatchId };
}

function tap(
  seeded: Seeded,
  overrides: Partial<Parameters<typeof repo.open>[0]> = {},
) {
  return repo.open({
    verificationId: seeded.verificationId,
    sourceProviderMessageId: seeded.wamid,
    sender: { kind: 'akeed_system' },
    eventId: `wamid.tap-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    shipping: 'unknown',
    ...overrides,
  });
}

async function openRequest(seeded: Seeded) {
  const result = await tap(seeded);
  if (result.outcome !== 'opened') throw new Error(result.outcome);
  return result.request;
}

async function statusOf(verificationId: string) {
  const [row] = await client<
    { status: string; confirmation_cycle: number }[]
  >`SELECT status, confirmation_cycle FROM verifications WHERE id = ${verificationId}`;
  return row;
}

async function needsActionOf(verificationId: string, orgId = orgA) {
  return verificationsRepo.findNeedsActionReason(verificationId, orgId);
}

function autoCancelService() {
  const registry = {
    inspectForCancellation: jest.fn(() =>
      Promise.resolve({ state: 'cancellable' }),
    ),
    dispatch: jest.fn(() => Promise.resolve({ status: 'applied' })),
    resolveOperation: jest.fn(() => Promise.resolve({ state: 'done' })),
  };
  const producer = {
    enqueueExecute: jest.fn(() => Promise.resolve()),
    enqueueConfirm: jest.fn(() => Promise.resolve()),
  };
  return {
    registry,
    service: new AutoCancellationService(
      autoCancelRepo,
      registry as never,
      producer as never,
    ),
  };
}

beforeAll(async () => {
  await client`CREATE SCHEMA ${client(namespace)}`;
  await client.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  for (const candidate of Object.values(tables)) {
    if (
      typeof candidate === 'function' &&
      'enumName' in candidate &&
      'enumValues' in candidate
    ) {
      const values = candidate.enumValues as string[];
      await client.unsafe(
        `CREATE TYPE "${String(candidate.enumName)}" AS ENUM (${values.map((item) => `'${item}'`).join(', ')})`,
      );
    }
  }
  for (const table of [
    tables.organizations,
    tables.integrations,
    tables.orders,
    tables.verifications,
    tables.verificationMessageDispatches,
    tables.commerceOutcomeSyncs,
    tables.verificationAutoCancellations,
    tables.verificationAutoCancellationEvents,
  ])
    await scaffold(table);
  // The new columns came from the scaffold; drop them so the migration adds
  // them to tables that already hold rows, then apply it twice to prove it
  // re-runs.
  await client.unsafe(`
    ALTER TABLE integrations DROP COLUMN change_requests_enabled;
    ALTER TABLE verifications DROP COLUMN confirmation_cycle;
    ALTER TABLE verification_message_dispatches DROP COLUMN confirmation_cycle;
  `);

  await db.insert(tables.organizations).values([
    { id: orgA, name: 'Store A', slug: `store-${orgA}` },
    { id: orgB, name: 'Store B', slug: `store-${orgB}` },
  ]);
  await client`
    INSERT INTO integrations (id, org_id, platform_type, platform_store_url, is_active, auto_cancel_enabled, quiet_hours_enabled)
    VALUES (${integrationA}, ${orgA}, 'shopify', 'change-a.myshopify.com', true, true, false),
           (${integrationB}, ${orgB}, 'shopify', 'change-b.myshopify.com', true, true, false)`;
  const legacyOrder = randomUUID();
  await client`
    INSERT INTO orders (id, org_id, integration_id, external_order_id, customer_phone)
    VALUES (${legacyOrder}, ${orgA}, ${integrationA}, ${`ext-${legacyOrder}`}, '+201000000009')`;
  await client`
    INSERT INTO verifications (id, org_id, order_id, status)
    VALUES (${legacyVerificationId}, ${orgA}, ${legacyOrder}, 'sent')`;

  await migrate('0092_change_requests.sql');
  await migrate('0092_change_requests.sql');
});

afterAll(async () => {
  await client`DROP SCHEMA IF EXISTS ${client(namespace)} CASCADE`;
  await client.end();
});

describe('change requests against PostgreSQL', () => {
  describe('migration', () => {
    it('keeps existing stores off and existing orders in cycle 1', async () => {
      const stores = await client<{ change_requests_enabled: boolean }[]>`
        SELECT change_requests_enabled FROM integrations`;
      expect(stores.map((store) => store.change_requests_enabled)).toEqual([
        false,
        false,
      ]);
      expect(await statusOf(legacyVerificationId)).toEqual({
        status: 'sent',
        confirmation_cycle: 1,
      });
      // A legacy order without any change request still escalates normally.
      const rows = await verificationsRepo.updateStatus(
        legacyVerificationId,
        'no_reply',
      );
      expect(rows).toHaveLength(1);
    });

    it('refuses a second open request for one verification', async () => {
      const seeded = await seed();
      await openRequest(seeded);
      await expect(
        client`
          INSERT INTO verification_change_requests (org_id, integration_id, order_id, verification_id, confirmation_cycle, source_dispatch_id, source_provider_message_id, sender_kind, opened_event_id, opened_at)
          VALUES (${orgA}, ${integrationA}, ${seeded.orderId}, ${seeded.verificationId}, 2, ${seeded.dispatchId}, ${seeded.wamid}, 'akeed_system', 'evt', now())`,
      ).rejects.toThrow(/verification_change_requests_one_open/);
    });
  });

  describe('opening', () => {
    it('creates one request, one history entry and one set of effects for concurrent taps', async () => {
      const seeded = await seed();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          tap(seeded, { eventId: `wamid.tap-${index}` }),
        ),
      );

      expect(results.filter((r) => r.outcome === 'opened')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'already_open')).toHaveLength(
        5,
      );
      const requests = await client`
        SELECT id FROM verification_change_requests WHERE verification_id = ${seeded.verificationId}`;
      expect(requests).toHaveLength(1);
      const effects = await repo.listEffects(requests[0].id as string, orgA);
      expect(effects.map((effect) => effect.kind).sort()).toEqual([
        'customer_acknowledgment',
        'merchant_email',
        'platform_marker_set',
      ]);

      // The same provider event delivered again is recorded once.
      await tap(seeded, { eventId: 'wamid.tap-3' });
      const history = await repo.listHistory(requests[0].id as string, orgA);
      expect(history.filter((e) => e.event === 'opened')).toHaveLength(1);
      expect(history.filter((e) => e.event === 'repeat_ignored')).toHaveLength(
        5,
      );
      expect(await needsActionOf(seeded.verificationId)).toBe(
        'change_requested',
      );
    });

    it.each([
      [{ status: 'confirmed' as const }, 'not_awaiting_confirmation'],
      [{ status: 'canceled' as const }, 'not_awaiting_confirmation'],
      [{ status: 'pending' as const }, 'not_awaiting_confirmation'],
    ])('rejects %o', async (verification, reason) => {
      const seeded = await seed({ verification });
      expect(await tap(seeded)).toEqual({ outcome: 'rejected', reason });
    });

    it('rejects a known-shipped order and accepts unknown shipping', async () => {
      const shipped = await seed();
      expect(await tap(shipped, { shipping: 'shipped' })).toEqual({
        outcome: 'rejected',
        reason: 'known_shipped',
      });
      const unknown = await seed();
      expect((await tap(unknown, { shipping: 'unknown' })).outcome).toBe(
        'opened',
      );
    });

    it('binds the request to its tenant, message, sender and cycle', async () => {
      const seeded = await seed();
      const other = await seed();
      const request = await openRequest(seeded);

      expect(request).toMatchObject({
        orgId: orgA,
        integrationId: integrationA,
        orderId: seeded.orderId,
        verificationId: seeded.verificationId,
        confirmationCycle: 1,
        sourceDispatchId: seeded.dispatchId,
        sourceProviderMessageId: seeded.wamid,
        senderKind: 'akeed_system',
        status: 'open',
      });

      // A button naming one order but quoting another order's message.
      expect(
        await tap(other, { sourceProviderMessageId: seeded.wamid }),
      ).toEqual({ outcome: 'rejected', reason: 'message_mismatch' });
      expect(
        await tap(other, {
          sender: { kind: 'merchant_own', phoneNumberId: 'pn-1' },
        }),
      ).toEqual({ outcome: 'rejected', reason: 'sender_mismatch' });
      expect(await tap(other, { cycle: 2 })).toEqual({
        outcome: 'rejected',
        reason: 'message_mismatch',
      });
    });

    it('keeps the same customer at two merchants apart', async () => {
      const atA = await seed();
      const atB = await seed({ orgId: orgB, integrationId: integrationB });

      // Routing reached merchant B's number; the button names A's order.
      expect(await tap(atA, { expectedOrgId: orgB })).toEqual({
        outcome: 'rejected',
        reason: 'tenant_mismatch',
      });
      const request = await openRequest(atB);
      expect(request.orgId).toBe(orgB);
      expect(
        await repo.findOpenForVerification(atA.verificationId, orgA),
      ).toBeUndefined();
      // B's request is invisible and immutable from A's tenant.
      expect(
        await repo.findOpenForVerification(atB.verificationId, orgA),
      ).toBeUndefined();
      expect(await repo.findById(request.id, orgA)).toBeUndefined();
      expect(await repo.listHistory(request.id, orgA)).toEqual([]);
      expect(
        await repo.resolveByMerchantConfirmation({
          orgId: orgA,
          verificationId: atB.verificationId,
          actorUserId: randomUUID(),
        }),
      ).toEqual({ outcome: 'rejected', reason: 'verification_not_found' });
      expect((await statusOf(atB.verificationId)).status).toBe('delivered');
    });

    it('opens on a no-reply order and stops its scheduled cancellation', async () => {
      const seeded = await seed({
        verification: {
          status: 'no_reply',
          noReplyAt: ago(HOUR),
          followUpAttempts: 0,
        },
      });
      const { service, registry } = autoCancelService();
      await service.scheduleAfterNoReply(seeded.verificationId);
      const scheduled = await autoCancelRepo.findByVerification(
        seeded.verificationId,
        orgA,
      );
      expect(scheduled?.status).toBe('scheduled');

      const result = await tap(seeded);
      expect(result).toMatchObject({
        outcome: 'opened',
        stoppedAutoCancellation: true,
      });

      // The job queued before the request now finds it stopped.
      await service.execute(scheduled!.id);
      expect(registry.dispatch).not.toHaveBeenCalled();
      expect(
        await autoCancelRepo.findByVerification(seeded.verificationId, orgA),
      ).toMatchObject({ status: 'stopped', reason: 'change_requested' });
      expect((await statusOf(seeded.verificationId)).status).toBe('no_reply');
    });

    it('rejects a request once the cancellation is reaching the store', async () => {
      const seeded = await seed({ verification: { status: 'no_reply' } });
      await client`
        INSERT INTO verification_auto_cancellations (org_id, verification_id, order_id, integration_id, status)
        VALUES (${orgA}, ${seeded.verificationId}, ${seeded.orderId}, ${integrationA}, 'in_progress')`;
      expect(await tap(seeded)).toEqual({
        outcome: 'rejected',
        reason: 'auto_cancel_committed',
      });
    });
  });

  describe('automation guards', () => {
    it('keeps an escalation queued before the request from reaching no reply', async () => {
      const seeded = await seed();
      await openRequest(seeded);

      const rows = await verificationsRepo.updateStatus(
        seeded.verificationId,
        'no_reply',
      );

      expect(rows).toEqual([]);
      expect((await statusOf(seeded.verificationId)).status).toBe('delivered');
    });

    it('never loses the request or cancels the order when a request races the escalation', async () => {
      const { service, registry } = autoCancelService();
      for (let round = 0; round < 10; round += 1) {
        const seeded = await seed({ verification: { followUpAttempts: 0 } });
        const [opened, escalated] = await Promise.all([
          tap(seeded),
          verificationsRepo.updateStatus(seeded.verificationId, 'no_reply'),
        ]);
        // Either serial order is allowed: the request kept the order out of
        // no reply, or the escalation came first and the request opened on
        // the no-reply order. The automatic cancellation the escalation then
        // decides sees the request either way.
        expect(opened.outcome).toBe('opened');
        const { status } = await statusOf(seeded.verificationId);
        expect(status).toBe(escalated.length > 0 ? 'no_reply' : 'delivered');
        if (escalated.length > 0)
          await service.scheduleAfterNoReply(seeded.verificationId);
        const row = await autoCancelRepo.findByVerification(
          seeded.verificationId,
          orgA,
        );
        expect(row?.status ?? 'none').not.toBe('scheduled');
        expect(await needsActionOf(seeded.verificationId)).toBe(
          'change_requested',
        );
      }
      expect(registry.dispatch).not.toHaveBeenCalled();
    });

    it('refuses the reminder claim while a request is open', async () => {
      const seeded = await seed();
      await openRequest(seeded);

      const claim = await dispatches.claim({
        orgId: orgA,
        integrationId: integrationA,
        verificationId: seeded.verificationId,
        kind: 'follow_up',
        templateName: 'akeed_cod_reminder',
        languageCode: 'ar',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(claim).toEqual({
        outcome: 'blocked',
        reason: 'change_request_open',
      });
      const followUps = await client`
        SELECT id FROM verification_message_dispatches
        WHERE verification_id = ${seeded.verificationId} AND kind = 'follow_up'`;
      expect(followUps).toHaveLength(0);
    });
  });

  describe('customer resolution', () => {
    it.each([
      ['confirmed', 'customer_confirmed'],
      ['canceled', 'customer_canceled'],
    ] as const)(
      'closes the request when the customer answers %s from the current cycle',
      async (intent, resolution) => {
        const seeded = await seed();
        const request = await openRequest(seeded);

        await verificationsRepo.updateStatus(
          seeded.verificationId,
          intent,
          undefined,
          undefined,
          intent === 'confirmed'
            ? { confirmationSource: 'customer' }
            : { cancellationSource: 'customer' },
        );
        const resolved = await repo.resolveByCustomerAnswer({
          verificationId: seeded.verificationId,
          intent,
          eventId: 'wamid.answer-1',
        });

        expect(resolved?.request).toMatchObject({
          id: request.id,
          status: 'resolved',
          resolution,
          resolvedByUserId: null,
        });
        expect(
          (await repo.listEffects(request.id, orgA)).map((e) => e.kind),
        ).toContain('platform_marker_clear');
        expect(await needsActionOf(seeded.verificationId)).toBeNull();
        // A replay of the answer changes nothing more.
        expect(
          await repo.resolveByCustomerAnswer({
            verificationId: seeded.verificationId,
            intent,
            eventId: 'wamid.answer-1',
          }),
        ).toBeNull();
        // A late Change tap cannot reopen a settled order.
        expect(await tap(seeded)).toEqual({
          outcome: 'rejected',
          reason: 'not_awaiting_confirmation',
        });
      },
    );

    it('does not close the request under the customer name for a merchant outcome', async () => {
      const seeded = await seed();
      await openRequest(seeded);
      await verificationsRepo.markMerchantConfirmed(
        seeded.verificationId,
        orgA,
        randomUUID(),
      );
      expect(
        await repo.resolveByCustomerAnswer({
          verificationId: seeded.verificationId,
          intent: 'confirmed',
        }),
      ).toBeNull();
    });
  });

  describe('merchant resolution', () => {
    it('confirms after contact and records the merchant', async () => {
      const seeded = await seed();
      const request = await openRequest(seeded);
      const actor = randomUUID();

      const result = await repo.resolveByMerchantConfirmation({
        orgId: orgA,
        verificationId: seeded.verificationId,
        changeRequestId: request.id,
        actorUserId: actor,
      });

      expect(result).toMatchObject({
        outcome: 'resolved',
        request: { resolution: 'merchant_confirmed', resolvedByUserId: actor },
        verification: {
          status: 'confirmed',
          confirmationSource: 'merchant_manual',
        },
      });
      const history = await repo.listHistory(request.id, orgA);
      expect(history.at(-1)).toMatchObject({
        event: 'resolved',
        actorKind: 'merchant',
        actorUserId: actor,
      });
      // A double submission is answered, not applied twice.
      expect(
        await repo.resolveByMerchantConfirmation({
          orgId: orgA,
          verificationId: seeded.verificationId,
          actorUserId: actor,
        }),
      ).toMatchObject({
        outcome: 'already_resolved',
        verificationStatus: 'confirmed',
      });
    });

    it('keeps the plain manual confirmation from bypassing an open request', async () => {
      const seeded = await seed();
      await openRequest(seeded);

      expect(
        await verificationsRepo.markMerchantConfirmed(
          seeded.verificationId,
          orgA,
          randomUUID(),
        ),
      ).toBeNull();
      expect((await statusOf(seeded.verificationId)).status).toBe('delivered');
      // The existing no-reply cancellation does not apply to it either.
      expect(
        await verificationsRepo.markMerchantNoReplyCanceled(
          seeded.verificationId,
          orgA,
          new Date().toISOString(),
        ),
      ).toBeNull();
    });

    it('cancels after contact with its own cancellation source', async () => {
      const seeded = await seed();
      await openRequest(seeded);

      const result = await repo.resolveByMerchantCancellation({
        orgId: orgA,
        verificationId: seeded.verificationId,
        actorUserId: randomUUID(),
        operation: { status: 'applied' },
      });

      expect(result).toMatchObject({
        outcome: 'resolved',
        request: { resolution: 'merchant_canceled' },
        verification: {
          status: 'canceled',
          cancellationSource: 'merchant_change_request',
        },
      });
      // A customer tap that arrives later cannot revive the order.
      const rows = await verificationsRepo.updateStatus(
        seeded.verificationId,
        'confirmed',
      );
      expect(rows).toEqual([]);
    });

    it('leaves a customer resolution that won the race as it is', async () => {
      const seeded = await seed();
      await openRequest(seeded);
      const customer = (async () => {
        await verificationsRepo.updateStatus(
          seeded.verificationId,
          'canceled',
          undefined,
          undefined,
          { cancellationSource: 'customer' },
        );
        return repo.resolveByCustomerAnswer({
          verificationId: seeded.verificationId,
          intent: 'canceled',
        });
      })();
      const [customerResult, merchantResult] = await Promise.all([
        customer,
        repo.resolveByMerchantConfirmation({
          orgId: orgA,
          verificationId: seeded.verificationId,
          actorUserId: randomUUID(),
        }),
      ]);

      const { status } = await statusOf(seeded.verificationId);
      const [request] = await client<{ status: string; resolution: string }[]>`
        SELECT status, resolution FROM verification_change_requests
        WHERE verification_id = ${seeded.verificationId}`;
      expect(request.status).toBe('resolved');
      if (merchantResult.outcome === 'resolved') {
        // The merchant confirmed first; the customer's cancel then found a
        // confirmed order and changed nothing.
        expect(status).toBe('confirmed');
        expect(request.resolution).toBe('merchant_confirmed');
        expect(customerResult).toBeNull();
      } else {
        expect(merchantResult.outcome).toBe('already_resolved');
        expect(status).toBe('canceled');
        expect(request.resolution).toBe('customer_canceled');
      }
    });
  });

  describe('reconfirmation', () => {
    it('keeps the request open and the automation stopped when the resend fails', async () => {
      const seeded = await seed();
      const request = await openRequest(seeded);

      expect(
        await repo.recordReconfirmationFailure({
          orgId: orgA,
          verificationId: seeded.verificationId,
          changeRequestId: request.id,
          reason: 'INSUFFICIENT_CREDITS',
        }),
      ).toBe('recorded');

      expect(
        await repo.findOpenForVerification(seeded.verificationId, orgA),
      ).toMatchObject({
        id: request.id,
        status: 'open',
        lastReconfirmationError: 'INSUFFICIENT_CREDITS',
      });
      expect(
        await verificationsRepo.updateStatus(seeded.verificationId, 'no_reply'),
      ).toEqual([]);
      expect(await statusOf(seeded.verificationId)).toEqual({
        status: 'delivered',
        confirmation_cycle: 1,
      });
    });

    it('starts a fresh cycle on success and retires the old buttons', async () => {
      const seeded = await seed({
        verification: {
          status: 'no_reply',
          noReplyAt: ago(HOUR),
          followUpAttempts: 1,
          followUpSentAt: ago(HOUR),
          metadata: { follow_up_skipped: 'INSUFFICIENT_CREDITS' },
        },
      });
      await client`
        INSERT INTO verification_auto_cancellations (org_id, verification_id, order_id, integration_id, status, reason)
        VALUES (${orgA}, ${seeded.verificationId}, ${seeded.orderId}, ${integrationA}, 'paused', 'reminder_blocked')`;
      const request = await openRequest(seeded);
      const base = {
        orgId: orgA,
        verificationId: seeded.verificationId,
        changeRequestId: request.id,
        providerMessageId: 'wamid.reconfirmation-1',
        sentAt: new Date().toISOString(),
      };

      expect(
        await repo.completeReconfirmation({ ...base, expectedCycle: 2 }),
      ).toEqual({ outcome: 'rejected', reason: 'stale_cycle' });

      const [first, second] = await Promise.all([
        repo.completeReconfirmation({ ...base, expectedCycle: 1 }),
        repo.completeReconfirmation({ ...base, expectedCycle: 1 }),
      ]);
      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(['already_resolved', 'completed']);

      const [verification] = await client`
        SELECT status, confirmation_cycle, wa_message_id, follow_up_attempts, follow_up_sent_at, no_reply_at, delivered_at, metadata
        FROM verifications WHERE id = ${seeded.verificationId}`;
      expect(verification).toMatchObject({
        status: 'sent',
        confirmation_cycle: 2,
        wa_message_id: 'wamid.reconfirmation-1',
        follow_up_attempts: 0,
        follow_up_sent_at: null,
        no_reply_at: null,
        delivered_at: null,
      });
      expect(verification.metadata).not.toHaveProperty('follow_up_skipped');
      expect(
        await autoCancelRepo.findByVerification(seeded.verificationId, orgA),
      ).toBeUndefined();
      const [closed] = await client<{ resolution: string }[]>`
        SELECT resolution FROM verification_change_requests WHERE id = ${request.id}`;
      expect(closed.resolution).toBe('reconfirmation_sent');

      // A Change button from the retired cycle opens nothing.
      expect(await tap(seeded)).toEqual({
        outcome: 'rejected',
        reason: 'stale_cycle',
      });
      // The new cycle runs its normal automation again.
      expect(
        await verificationsRepo.updateStatus(seeded.verificationId, 'no_reply'),
      ).toHaveLength(1);
    });
  });

  describe('effect outbox', () => {
    it('hands each effect to one worker and ignores a stale settle', async () => {
      const seeded = await seed();
      const request = await openRequest(seeded);
      // Other tests leave pending emails too; claim until this request's.
      const claimed = await Promise.all(
        Array.from({ length: 4 }, () =>
          repo.claimEffect('merchant_email', 60_000),
        ),
      );
      const ids = claimed.filter(Boolean).map((effect) => effect!.id);
      expect(new Set(ids).size).toBe(ids.length);

      let mine = claimed.find(
        (effect) => effect?.changeRequestId === request.id,
      );
      while (!mine) {
        const next = await repo.claimEffect('merchant_email', 60_000);
        if (!next) throw new Error('effect not claimable');
        if (next.changeRequestId === request.id) mine = next;
      }
      expect(
        await repo.settleEffect({
          effectId: mine.id,
          attempts: mine.attempts + 1,
          status: 'done',
        }),
      ).toBe(false);
      expect(
        await repo.settleEffect({
          effectId: mine.id,
          attempts: mine.attempts,
          status: 'done',
        }),
      ).toBe(true);
    });
  });
});
