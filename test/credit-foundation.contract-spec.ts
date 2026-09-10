import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from '../src/infrastructure/database/schema';
import * as relationDefinitions from '../src/infrastructure/database/relations';
import type { CreditTransaction } from '../src/infrastructure/database/credit-transaction';
import {
  CreditAccountingRepository,
  CreditInvariantError,
  CreditVersionConflictError,
} from '../src/infrastructure/database/repositories/credit-accounting.repository';
import {
  PaymentPurchasesRepository,
  PaymentRequestConflictError,
} from '../src/infrastructure/database/repositories/payment-purchases.repository';

function databaseUrl(): string {
  const value = process.env.E045_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'NOT RUN: E045_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid E045 test database URL (value withheld)');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/akeed_e045_test' ||
    url.username !== 'e045_test' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Use local PostgreSQL, database akeed_e045_test and user e045_test, without query parameters.',
    );
  }
  return value;
}

const namespace = `e045_${randomUUID().replaceAll('-', '')}`;
const notices: string[] = [];
const client = postgres(databaseUrl(), {
  max: 8,
  connect_timeout: 5,
  onnotice: (notice) => {
    if (notice.message?.startsWith('US-04.5-01')) notices.push(notice.message);
  },
  connection: { search_path: `${namespace},public` },
});
const db = drizzle(client, { schema: { ...schema, ...relationDefinitions } });
const credit = new CreditAccountingRepository(db);
const payments = new PaymentPurchasesRepository(db);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const shopifyOrgId = randomUUID();
const integrationId = randomUUID();
const verificationId = randomUUID();
const legacyDispatchId = randomUUID();
const actorId = randomUUID();
const rollback = new Error('rollback test fixture');
let created = false;

function migration() {
  return readFileSync(
    resolve(
      __dirname,
      '../drizzle/0032_credit_and_payment_domain_foundation.sql',
    ),
    'utf8',
  )
    .replaceAll('"public"', `"${namespace}"`)
    .replaceAll("'public.", `'${namespace}.`)
    .replaceAll("'public'", `'${namespace}'`)
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(tx: CreditTransaction) {
  for (const statement of migration()) await tx.execute(sql.raw(statement));
}

async function isolated(work: (tx: CreditTransaction) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await work(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

function newPurchase(
  overrides: Partial<Parameters<typeof payments.createPending>[1]> = {},
) {
  return {
    orgId,
    reference: randomUUID(),
    provider: 'paymob',
    mode: 'test',
    requestKey: randomUUID(),
    requestHash: 'a'.repeat(64),
    quantity: 100,
    unitPriceMinor: 200,
    totalMinor: 20000,
    currency: 'EGP',
    ...overrides,
  };
}

async function grant(
  tx: CreditTransaction,
  overrides: Partial<typeof schema.creditLedgerEntries.$inferInsert> = {},
) {
  return credit.insertLedgerEntry(tx, {
    orgId,
    type: 'free_grant',
    quantity: 30,
    idempotencyKey: randomUUID(),
    actorId,
    reason: 'Synthetic contract fixture',
    postedBalanceBefore: 0,
    postedBalanceAfter: 30,
    ...overrides,
  });
}

async function dispatch(
  tx: CreditTransaction,
  overrides: Partial<{
    orgId: string;
    integrationId: string;
    verificationId: string;
    dispatchKey: string;
    generation: number;
    kind: 'initial' | 'follow_up' | 'legacy_unknown';
    state: 'ready' | 'sending' | 'accepted' | 'rejected' | 'outcome_unknown';
    failedAt: string | null;
  }> = {},
) {
  const input = {
    orgId,
    integrationId,
    verificationId,
    kind: 'initial' as const,
    generation: 1,
    dispatchKey: `${verificationId}:initial:1`,
    state: 'ready' as const,
    failedAt: null,
    ...overrides,
  };
  const [result] = await tx.execute<{
    id: string;
    generation: number;
    state: string;
  }>(sql`
    INSERT INTO verification_message_dispatches (
      org_id, integration_id, verification_id, dispatch_key,
      generation, kind, state, failed_at
    ) VALUES (
      ${input.orgId}, ${input.integrationId}, ${input.verificationId},
      ${input.dispatchKey}, ${input.generation},
      ${input.kind}::verification_dispatch_kind,
      ${input.state}::verification_dispatch_state, ${input.failedAt}
    )
    RETURNING id, generation, state
  `);
  return result;
}

async function reservation(
  tx: CreditTransaction,
  dispatchId: string,
  overrides: Partial<typeof schema.creditReservations.$inferInsert> = {},
) {
  return credit.insertReservation(tx, {
    orgId,
    dispatchId,
    verificationId,
    kind: 'initial',
    generation: 1,
    quantity: 1,
    billableKey: `${verificationId}:initial:1`,
    ...overrides,
  });
}

describe('US-04.5-01 disposable PostgreSQL foundation', () => {
  beforeAll(async () => {
    await client`CREATE SCHEMA ${client(namespace)}`;
    created = true;
    await client.unsafe(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA "${namespace}" TO service_role, authenticated, anon;
      CREATE FUNCTION get_user_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.org_id', true), '')::uuid $$;
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE integrations (id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), platform_type text NOT NULL, plan_id text DEFAULT 'starter', UNIQUE(id, org_id));
      CREATE TABLE verifications (id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), UNIQUE(id, org_id));
      CREATE TABLE integration_monthly_usage (org_id uuid, consumed_count integer);
      CREATE TYPE verification_dispatch_kind AS ENUM ('initial', 'follow_up', 'legacy_unknown');
      CREATE TYPE verification_dispatch_state AS ENUM ('ready', 'sending', 'accepted', 'rejected', 'outcome_unknown');
    `);
    const dispatchDdl = readFileSync(
      resolve(
        __dirname,
        '../drizzle/0028_manual_order_lifecycle_dispatch_ledger.sql',
      ),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .find((statement) =>
        statement.includes(
          'CREATE TABLE IF NOT EXISTS "public"."verification_message_dispatches"',
        ),
      );
    if (!dispatchDdl) throw new Error('Missing E04 dispatch migration');
    await client.unsafe(dispatchDdl.replaceAll('"public".', `"${namespace}".`));
    await client`INSERT INTO organizations VALUES (${orgId}), (${otherOrgId}), (${shopifyOrgId})`;
    await client`INSERT INTO integrations (id, org_id, platform_type) VALUES (${integrationId}, ${orgId}, 'standalone'), (${randomUUID()}, ${otherOrgId}, 'standalone'), (${randomUUID()}, ${shopifyOrgId}, 'shopify')`;
    await client`INSERT INTO verifications VALUES (${verificationId}, ${orgId})`;
    await client`INSERT INTO integration_monthly_usage VALUES (${orgId}, 17), (${shopifyOrgId}, 9)`;
    await client`INSERT INTO verification_message_dispatches (id, org_id, integration_id, verification_id, dispatch_key, kind, state) VALUES (${legacyDispatchId}, ${orgId}, ${integrationId}, ${verificationId}, ${`${verificationId}:legacy:1`}, 'legacy_unknown', 'accepted')`;
    await expect(
      db.transaction(async (tx) => {
        await applyMigration(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const [afterRollback] =
      await client`SELECT to_regclass(${`${namespace}.credit_accounts`}) AS account_table`;
    expect(afterRollback.account_table).toBeNull();
    await db.transaction(applyMigration);
    await db.transaction(applyMigration);
  });

  afterAll(async () => {
    if (created) await client`DROP SCHEMA ${client(namespace)} CASCADE`;
    await client.end();
  });

  it('records preflight totals, backfills pending zero accounts, and preserves legacy facts', async () => {
    expect(notices).toContain(
      'US-04.5-01 preflight: standalone_sources=2, accounts_to_insert=2, legacy_dispatches=1, identity_anomalies=0',
    );
    expect(notices).toContain(
      'US-04.5-01 preflight: standalone_sources=2, accounts_to_insert=0, legacy_dispatches=1, identity_anomalies=0',
    );
    const accounts = await db.select().from(schema.creditAccounts);
    expect(accounts).toHaveLength(2);
    for (const account of accounts)
      expect(account).toMatchObject({
        status: 'pending_approval',
        postedBalance: 0,
        heldCredits: 0,
        version: 0,
      });
    expect(await db.select().from(schema.creditLedgerEntries)).toHaveLength(0);
    expect(await db.select().from(schema.paymentPurchases)).toHaveLength(0);
    const [legacy] = await client`
      SELECT id, generation, state
      FROM verification_message_dispatches
    `;
    expect(legacy).toMatchObject({
      id: legacyDispatchId,
      generation: 1,
      state: 'accepted',
    });
    expect(
      (
        await client`SELECT consumed_count FROM integration_monthly_usage ORDER BY consumed_count`
      ).map((row) => Number(row.consumed_count)),
    ).toEqual([9, 17]);
    expect(
      (await client`SELECT DISTINCT plan_id FROM integrations`).map((row) =>
        String(row.plan_id),
      ),
    ).toEqual(['starter']);
  });

  it('preserves purchases and ledger across replay and forward recovery', async () =>
    isolated(async (tx) => {
      const entry = await grant(tx);
      const purchase = await payments.createPending(tx, newPurchase());
      await credit.updateProjection(tx, {
        orgId,
        expectedVersion: 0,
        postedBalance: 30,
        heldCredits: 0,
      });
      await applyMigration(tx);
      expect(
        await credit.findLedgerEntry(tx, orgId, entry.idempotencyKey),
      ).toEqual(entry);
      expect(
        await payments.lockPurchase(tx, orgId, purchase.purchase.id),
      ).toEqual(purchase.purchase);
      expect(await credit.checkInvariant(orgId, tx)).toMatchObject({
        consistent: true,
        postedBalance: 30,
      });
    }));

  it('aborts migration for incompatible billable identities', async () =>
    isolated(async (tx) => {
      await tx.execute(
        sql.raw(
          'ALTER TABLE verification_message_dispatches DROP CONSTRAINT dispatch_billable_identity_key',
        ),
      );
      await tx.execute(sql.raw('DROP INDEX dispatch_one_active_generation'));
      await dispatch(tx, {
        kind: 'legacy_unknown',
        dispatchKey: 'duplicate-legacy',
        state: 'accepted',
      });
      await expect(tx.transaction(applyMigration)).rejects.toThrow(
        'incompatible dispatch identities',
      );
    }));

  it.each([
    [
      'negative held balance',
      'UPDATE credit_accounts SET held_credits = -1, version = version + 1',
    ],
    ['unversioned projection', 'UPDATE credit_accounts SET posted_balance = 2'],
    [
      'invalid account status',
      "UPDATE credit_accounts SET status = 'approved', version = version + 1",
    ],
  ])('rejects %s', async (_name, statement) =>
    isolated(async (tx) => {
      await expect(
        tx.transaction((nested) => nested.execute(sql.raw(statement))),
      ).rejects.toThrow();
    }),
  );

  it.each([
    { quantity: 0, totalMinor: 0 },
    { quantity: -1, totalMinor: -200 },
    { quantity: 1.5, totalMinor: 300 },
    { totalMinor: 19999 },
    { unitPriceMinor: 0 },
    { currency: 'egp' },
  ])('rejects invalid purchase economics %j', async (changes) =>
    isolated(async (tx) => {
      await expect(
        tx.transaction((nested) =>
          payments.createPending(nested, newPurchase(changes)),
        ),
      ).rejects.toThrow();
    }),
  );

  it('enforces purchase request idempotency, safe tenant lookup, and immutable terms', async () =>
    isolated(async (tx) => {
      const input = newPurchase();
      const first = await payments.createPending(tx, input);
      const duplicate = await payments.createPending(tx, {
        ...input,
        reference: randomUUID(),
      });
      expect(duplicate).toEqual({ purchase: first.purchase, duplicate: true });
      await expect(
        tx.transaction((nested) =>
          payments.createPending(nested, {
            ...input,
            quantity: 150,
            totalMinor: 30000,
          }),
        ),
      ).rejects.toBeInstanceOf(PaymentRequestConflictError);
      expect(
        await payments.lockPurchase(tx, otherOrgId, first.purchase.id),
      ).toBeUndefined();
      await expect(
        tx.transaction((nested) =>
          nested.execute(
            sql`UPDATE payment_purchases SET quantity = 150, total_minor = 30000 WHERE id = ${first.purchase.id}`,
          ),
        ),
      ).rejects.toMatchObject({
        cause: {
          code: '23514',
          message: expect.stringContaining('immutable') as unknown,
        },
      });
      await expect(
        tx.transaction((nested) =>
          nested.execute(
            sql`DELETE FROM payment_purchases WHERE id = ${first.purchase.id}`,
          ),
        ),
      ).rejects.toMatchObject({
        cause: {
          code: '23514',
          message: expect.stringContaining('immutable') as unknown,
        },
      });
      await expect(
        tx.transaction((nested) =>
          nested.execute(
            sql`UPDATE payment_purchases SET refunded_minor = 20001 WHERE id = ${first.purchase.id}`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        tx.transaction((nested) =>
          nested.execute(
            sql`UPDATE payment_purchases SET status = 'paid' WHERE id = ${first.purchase.id}`,
          ),
        ),
      ).rejects.toThrow();
    }));

  it.each([
    'providerIntentionId',
    'providerOrderId',
    'providerTransactionId',
  ] as const)('keeps %s as a unique, write-once string', async (field) =>
    isolated(async (tx) => {
      const first = await payments.createPending(tx, newPurchase());
      const second = await payments.createPending(
        tx,
        newPurchase({ orgId: otherOrgId }),
      );
      const identifier = '900719925474099399999999999';
      const updated = await payments.updatePurchase(
        tx,
        orgId,
        first.purchase.id,
        'pending',
        { [field]: identifier },
      );
      expect(updated[field]).toBe(identifier);
      await expect(
        tx.transaction((nested) =>
          payments.updatePurchase(
            nested,
            otherOrgId,
            second.purchase.id,
            'pending',
            { [field]: identifier },
          ),
        ),
      ).rejects.toThrow();
      await expect(
        tx.transaction((nested) =>
          payments.updatePurchase(nested, orgId, first.purchase.id, 'pending', {
            [field]: 'different',
          }),
        ),
      ).rejects.toMatchObject({
        cause: {
          code: '23514',
          message: expect.stringContaining('immutable') as unknown,
        },
      });
    }),
  );

  it('makes ledger history immutable and grant sources unique despite different request keys', async () =>
    isolated(async (tx) => {
      await grant(tx);
      await expect(tx.transaction((nested) => grant(nested))).rejects.toThrow();
      for (const statement of [
        "UPDATE credit_ledger_entries SET reason = 'changed'",
        'DELETE FROM credit_ledger_entries',
        'TRUNCATE credit_ledger_entries',
      ]) {
        await expect(
          tx.transaction((nested) => nested.execute(sql.raw(statement))),
        ).rejects.toMatchObject({
          cause: {
            code: '23514',
            message: expect.stringContaining('immutable') as unknown,
          },
        });
      }
    }));

  it.each([
    { quantity: 0, postedBalanceAfter: 0 },
    { quantity: -30, postedBalanceAfter: -30 },
    { quantity: 1.5, postedBalanceAfter: 1.5 },
    { postedBalanceAfter: 31 },
  ])('rejects invalid ledger values %j', async (changes) =>
    isolated(async (tx) => {
      await expect(
        tx.transaction((nested) => grant(nested, changes)),
      ).rejects.toThrow();
    }),
  );

  it('enforces tenant and source ownership for purchases, dispatches, reservations, and reversals', async () =>
    isolated(async (tx) => {
      const send = await dispatch(tx);
      const hold = await reservation(tx, send.id);
      await expect(
        tx.transaction((nested) =>
          reservation(nested, send.id, { orgId: otherOrgId }),
        ),
      ).rejects.toThrow();
      await expect(
        tx.transaction((nested) =>
          reservation(nested, send.id, {
            generation: 2,
            billableKey: 'wrong-generation',
          }),
        ),
      ).rejects.toThrow();
      const purchase = await payments.createPending(
        tx,
        newPurchase({ orgId: otherOrgId }),
      );
      await expect(
        tx.transaction((nested) =>
          grant(nested, {
            type: 'purchase',
            actorId: null,
            purchaseId: purchase.purchase.id,
            quantity: 100,
            postedBalanceAfter: 100,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        tx.transaction((nested) =>
          grant(nested, {
            orgId: otherOrgId,
            type: 'consumption',
            reservationId: hold.id,
            dispatchId: send.id,
            quantity: -1,
            postedBalanceAfter: -1,
          }),
        ),
      ).rejects.toThrow();
      const consumed = await grant(tx, {
        type: 'consumption',
        reservationId: hold.id,
        dispatchId: send.id,
        quantity: -1,
        postedBalanceAfter: -1,
      });
      await expect(
        tx.transaction((nested) =>
          grant(nested, {
            orgId: otherOrgId,
            type: 'failure_reversal',
            reservationId: hold.id,
            dispatchId: send.id,
            sourceLedgerEntryId: consumed.id,
            quantity: 1,
            postedBalanceAfter: 1,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        tx.transaction((nested) =>
          payments.recordEvent(nested, {
            orgId,
            purchaseId: purchase.purchase.id,
            provider: 'paymob',
            fingerprint: 'b'.repeat(64),
            payloadHash: 'c'.repeat(64),
            resultCode: 'matched',
          }),
        ),
      ).rejects.toThrow();
    }));

  it('deduplicates payment postings and callback fingerprints without storing payloads', async () =>
    isolated(async (tx) => {
      const { purchase } = await payments.createPending(tx, newPurchase());
      const posting = {
        type: 'purchase' as const,
        purchaseId: purchase.id,
        quantity: 100,
        postedBalanceAfter: 100,
      };
      await grant(tx, posting);
      await expect(
        tx.transaction((nested) => grant(nested, posting)),
      ).rejects.toThrow();
      const event = {
        orgId,
        purchaseId: purchase.id,
        provider: 'paymob',
        fingerprint: 'b'.repeat(64),
        payloadHash: 'c'.repeat(64),
        verified: true,
        resultCode: 'matched',
      };
      expect(await payments.recordEvent(tx, event)).toMatchObject(event);
      expect(await payments.recordEvent(tx, event)).toBeUndefined();
      await expect(
        tx.transaction((nested) =>
          payments.recordEvent(nested, {
            ...event,
            fingerprint: 'd'.repeat(64),
            errorCode: 'email@example.com',
          }),
        ),
      ).rejects.toThrow();
      const columns = await tx.execute(
        sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${namespace} AND table_name = 'payment_provider_events'`,
      );
      expect(columns.map((column) => String(column.column_name))).not.toEqual(
        expect.arrayContaining([
          'raw_payload',
          'email',
          'phone',
          'client_secret',
          'checkout_url',
        ]),
      );
    }));

  it('enforces authenticated safe-column reads and no direct writes across roles', async () =>
    isolated(async (tx) => {
      await tx.execute(sql`SELECT set_config('test.org_id', ${orgId}, true)`);
      await tx.execute(sql.raw('SET LOCAL ROLE authenticated'));
      const own = await tx.execute(
        sql`SELECT org_id, status, posted_balance FROM credit_accounts`,
      );
      expect(own.map((row) => row.org_id)).toEqual([orgId]);
      for (const statement of [
        'SELECT * FROM credit_accounts',
        'SELECT request_hash FROM payment_purchases',
        'SELECT * FROM payment_provider_events',
        'UPDATE credit_accounts SET posted_balance = 100, version = version + 1',
        'DELETE FROM credit_ledger_entries',
        'INSERT INTO credit_accounts (org_id) SELECT org_id FROM credit_accounts',
      ])
        await expect(
          tx.transaction((nested) => nested.execute(sql.raw(statement))),
        ).rejects.toThrow();
      await tx.execute(sql.raw('RESET ROLE'));
      await tx.execute(sql.raw('SET LOCAL ROLE anon'));
      await expect(
        tx.transaction((nested) =>
          nested.execute(sql`SELECT org_id FROM credit_accounts`),
        ),
      ).rejects.toThrow();
    }));

  it('permits backend service writes and blocks cross-tenant references and ledger updates', async () =>
    isolated(async (tx) => {
      await tx.execute(sql.raw('SET LOCAL ROLE service_role'));
      await grant(tx);
      await payments.createPending(tx, newPurchase());
      await credit.updateProjection(tx, {
        orgId,
        expectedVersion: 0,
        postedBalance: 30,
        heldCredits: 0,
      });
      expect(await credit.checkInvariant(orgId, tx)).toMatchObject({
        consistent: true,
      });
      await expect(
        tx.transaction((nested) =>
          nested.execute(
            sql`UPDATE credit_ledger_entries SET reason = 'altered'`,
          ),
        ),
      ).rejects.toThrow();
    }));

  it('detects mismatches, permits debt, and rolls back ledger and projection together', async () => {
    await isolated(async (tx) => {
      await credit.lockAccount(tx, orgId);
      await grant(tx, {
        type: 'staff_adjustment',
        quantity: -5,
        postedBalanceAfter: -5,
      });
      expect(await credit.checkInvariant(orgId, tx)).toMatchObject({
        consistent: false,
      });
      await expect(credit.lockAccount(tx, orgId)).rejects.toBeInstanceOf(
        CreditInvariantError,
      );
      const account = await credit.updateProjection(tx, {
        orgId,
        expectedVersion: 0,
        postedBalance: -5,
        heldCredits: 0,
      });
      expect(credit.summary(account)).toMatchObject({
        debtCredits: 5,
        availableCredits: 0,
      });
      expect(await credit.checkInvariant(orgId, tx)).toMatchObject({
        consistent: true,
      });
      await expect(
        credit.updateProjection(tx, {
          orgId,
          expectedVersion: 0,
          postedBalance: 999,
          heldCredits: 0,
        }),
      ).rejects.toBeInstanceOf(CreditVersionConflictError);
    });
    expect(await credit.checkInvariant(orgId)).toMatchObject({
      consistent: true,
      postedBalance: 0,
    });
  });

  it('compares held reservation quantities rather than row counts', async () =>
    isolated(async (tx) => {
      const send = await dispatch(tx);
      await reservation(tx, send.id, { quantity: 3 });
      expect(await credit.checkInvariant(orgId, tx)).toMatchObject({
        reservationHolds: '3',
        consistent: false,
      });
      await credit.updateProjection(tx, {
        orgId,
        expectedVersion: 0,
        postedBalance: 0,
        heldCredits: 3,
      });
      expect(await credit.checkInvariant(orgId, tx)).toMatchObject({
        consistent: true,
      });
    }));

  it('scopes the invariant report to the requested organization', async () =>
    isolated(async (tx) => {
      await grant(tx, { orgId: otherOrgId });

      expect(await credit.checkInvariant(otherOrgId, tx)).toMatchObject({
        ledgerBalance: '30',
        consistent: false,
      });
      expect(await credit.checkInvariant(orgId, tx)).toMatchObject({
        ledgerBalance: '0',
        reservationHolds: '0',
        consistent: true,
      });
      await expect(credit.lockAccount(tx, orgId)).resolves.toMatchObject({
        orgId,
        postedBalance: 0,
      });
    }));

  it.each(['ready', 'sending', 'outcome_unknown', 'accepted'] as const)(
    'blocks a later generation after %s',
    async (state) =>
      isolated(async (tx) => {
        await dispatch(tx, { state });
        await expect(
          tx.transaction((nested) =>
            dispatch(nested, {
              generation: 2,
              dispatchKey: `${verificationId}:initial:2`,
            }),
          ),
        ).rejects.toMatchObject({
          cause: {
            code: '23514',
            message: expect.stringContaining(
              'confirmed preceding failure',
            ) as unknown,
          },
        });
      }),
  );

  it('requires resolved reservations and reversed consumption before a new generation', async () =>
    isolated(async (tx) => {
      const send = await dispatch(tx, {
        state: 'accepted',
        failedAt: new Date().toISOString(),
      });
      const hold = await reservation(tx, send.id);
      const next = (nested: CreditTransaction) =>
        dispatch(nested, {
          generation: 2,
          dispatchKey: `${verificationId}:initial:2`,
        });
      await expect(tx.transaction(next)).rejects.toMatchObject({
        cause: {
          code: '23514',
          message: expect.stringContaining('must be released') as unknown,
        },
      });
      const consumed = await grant(tx, {
        type: 'consumption',
        reservationId: hold.id,
        dispatchId: send.id,
        quantity: -1,
        postedBalanceAfter: -1,
      });
      await credit.resolveReservation(tx, orgId, hold.id, 'held', {
        status: 'consumed',
        resolutionCode: 'provider_accepted',
      });
      await credit.resolveReservation(tx, orgId, hold.id, 'consumed', {
        status: 'released',
        resolutionCode: 'delivery_failed',
      });
      await expect(tx.transaction(next)).rejects.toMatchObject({
        cause: {
          code: '23514',
          message: expect.stringContaining('must be reversed') as unknown,
        },
      });
      await grant(tx, {
        type: 'failure_reversal',
        reservationId: hold.id,
        dispatchId: send.id,
        sourceLedgerEntryId: consumed.id,
        quantity: 1,
        postedBalanceBefore: -1,
        postedBalanceAfter: 0,
      });
      expect(await next(tx)).toMatchObject({ generation: 2 });
      await expect(
        tx.transaction((nested) =>
          nested
            .update(schema.verificationMessageDispatches)
            .set({ generation: 4 })
            .where(eq(schema.verificationMessageDispatches.id, send.id)),
        ),
      ).rejects.toMatchObject({
        cause: {
          code: '23514',
          message: expect.stringContaining('immutable') as unknown,
        },
      });
    }));

  it('allows a later generation after confirmed rejection without creating retries itself', async () =>
    isolated(async (tx) => {
      await dispatch(tx, { state: 'rejected' });
      const next = await dispatch(tx, {
        generation: 2,
        dispatchKey: `${verificationId}:initial:2`,
      });
      expect(next).toMatchObject({ generation: 2, state: 'ready' });
      await expect(
        tx.transaction((nested) =>
          dispatch(nested, {
            generation: 3,
            dispatchKey: `${verificationId}:initial:3`,
          }),
        ),
      ).rejects.toThrow();
    }));

  it('matches Drizzle columns, unique constraints, checks, and foreign keys to the migration', async () => {
    for (const table of [
      schema.creditAccounts,
      schema.creditReservations,
      schema.creditLedgerEntries,
      schema.paymentPurchases,
      schema.paymentProviderEvents,
    ]) {
      const configuration = getTableConfig(table);
      const columns =
        await client`SELECT column_name FROM information_schema.columns WHERE table_schema = ${namespace} AND table_name = ${configuration.name}`;
      expect(
        columns.map((column) => String(column.column_name)).sort(),
      ).toEqual(configuration.columns.map((column) => column.name).sort());
      const constraints =
        await client`SELECT conname FROM pg_constraint WHERE conrelid = ${`${namespace}.${configuration.name}`}::regclass`;
      const names = constraints.map((constraint) => String(constraint.conname));
      for (const constraint of configuration.uniqueConstraints)
        expect(names).toContain(constraint.name);
      for (const constraint of configuration.checks)
        expect(names).toContain(constraint.name);
      for (const constraint of configuration.foreignKeys)
        expect(names).toContain(constraint.getName());
    }
  });

  it('keeps every safe financial read scoped to the authenticated organization', async () =>
    isolated(async (tx) => {
      await payments.createPending(tx, newPurchase());
      await payments.createPending(tx, newPurchase({ orgId: otherOrgId }));
      await grant(tx);
      await grant(tx, { orgId: otherOrgId });
      const send = await dispatch(tx);
      await reservation(tx, send.id);
      await tx.execute(
        sql`SELECT set_config('test.org_id', ${otherOrgId}, true)`,
      );
      await tx.execute(sql.raw('SET LOCAL ROLE authenticated'));
      for (const table of [
        'credit_accounts',
        'payment_purchases',
        'credit_ledger_entries',
      ]) {
        const rows = await tx.execute(sql.raw(`SELECT org_id FROM ${table}`));
        expect(rows.map((row) => row.org_id)).toEqual([otherOrgId]);
      }
      expect(
        await tx.execute(sql`SELECT id FROM credit_reservations`),
      ).toHaveLength(0);
      for (const table of [
        'credit_reservations',
        'credit_ledger_entries',
        'payment_purchases',
        'payment_provider_events',
      ]) {
        await expect(
          tx.transaction((nested) =>
            nested.execute(sql.raw(`DELETE FROM ${table}`)),
          ),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
      }
    }));

  it('enforces consumption, failure reversal, refund, dispute and staff adjustment sources', async () =>
    isolated(async (tx) => {
      const send = await dispatch(tx);
      const hold = await reservation(tx, send.id);
      const consumption = {
        type: 'consumption' as const,
        reservationId: hold.id,
        dispatchId: send.id,
        quantity: -1,
        postedBalanceAfter: -1,
      };
      const consumed = await grant(tx, consumption);
      await expect(
        tx.transaction((nested) => grant(nested, consumption)),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      const failure = {
        type: 'failure_reversal' as const,
        reservationId: hold.id,
        dispatchId: send.id,
        sourceLedgerEntryId: consumed.id,
        quantity: 1,
        postedBalanceBefore: -1,
        postedBalanceAfter: 0,
      };
      await grant(tx, failure);
      await expect(
        tx.transaction((nested) => grant(nested, failure)),
      ).rejects.toMatchObject({ cause: { code: '23505' } });

      const { purchase } = await payments.createPending(tx, newPurchase());
      const postedPurchase = await grant(tx, {
        type: 'purchase',
        purchaseId: purchase.id,
        quantity: 100,
        postedBalanceAfter: 100,
      });
      for (const type of ['refund_reversal', 'chargeback_reversal'] as const) {
        const reversal = {
          type,
          purchaseId: purchase.id,
          sourceLedgerEntryId: postedPurchase.id,
          sourceReference: `provider-${type}`,
          quantity: -10,
          postedBalanceBefore: 100,
          postedBalanceAfter: 90,
        };
        const entry = await grant(tx, reversal);
        await expect(
          tx.transaction((nested) => grant(nested, reversal)),
        ).rejects.toMatchObject({ cause: { code: '23505' } });
        if (type === 'chargeback_reversal') {
          const reinstatement = {
            ...reversal,
            type: 'chargeback_reinstatement' as const,
            sourceLedgerEntryId: entry.id,
            quantity: 10,
            postedBalanceBefore: 90,
            postedBalanceAfter: 100,
          };
          await grant(tx, reinstatement);
          await expect(
            tx.transaction((nested) => grant(nested, reinstatement)),
          ).rejects.toMatchObject({ cause: { code: '23505' } });
        }
      }
      const adjustment = {
        type: 'staff_adjustment' as const,
        idempotencyKey: 'staff-operation',
      };
      await grant(tx, adjustment);
      await expect(
        tx.transaction((nested) => grant(nested, adjustment)),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await grant(tx, { ...adjustment, orgId: otherOrgId });
    }));

  it('serializes concurrent account postings and rejects competing stale versions', async () => {
    const concurrentOrg = randomUUID();
    await client`INSERT INTO organizations VALUES (${concurrentOrg})`;
    await db.transaction((tx) =>
      credit.ensurePendingAccount(tx, concurrentOrg),
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        db.transaction(async (tx) => {
          const account = await credit.lockAccount(tx, concurrentOrg);
          await grant(tx, {
            orgId: concurrentOrg,
            type: 'staff_adjustment',
            idempotencyKey: `concurrent-${index}`,
            quantity: 1,
            postedBalanceBefore: account.postedBalance,
            postedBalanceAfter: account.postedBalance + 1,
          });
          await credit.updateProjection(tx, {
            orgId: concurrentOrg,
            expectedVersion: account.version,
            postedBalance: account.postedBalance + 1,
            heldCredits: 0,
          });
        }),
      ),
    );
    expect(await credit.checkInvariant(concurrentOrg)).toMatchObject({
      consistent: true,
      postedBalance: 8,
      ledgerBalance: '8',
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        db.transaction((tx) =>
          credit.updateProjection(tx, {
            orgId: concurrentOrg,
            expectedVersion: 8,
            postedBalance: 8,
            heldCredits: 0,
          }),
        ),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    for (const attempt of attempts)
      if (attempt.status === 'rejected')
        expect(attempt.reason).toBeInstanceOf(CreditVersionConflictError);
  });

  it('creates only one purchase under concurrent request replay', async () => {
    const input = newPurchase({ orgId: otherOrgId });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.transaction((tx) =>
          payments.createPending(tx, { ...input, reference: randomUUID() }),
        ),
      ),
    );
    expect(new Set(results.map((result) => result.purchase.id)).size).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(
      await payments.findForOrganization(orgId, results[0].purchase.reference),
    ).toBeUndefined();
    expect(
      await payments.findForOrganization(
        otherOrgId,
        results[0].purchase.reference,
      ),
    ).toMatchObject({ totalMinor: 20000 });
  });

  it('allows only one concurrent successor generation', async () => {
    const concurrentVerification = randomUUID();
    await client`INSERT INTO verifications VALUES (${concurrentVerification}, ${orgId})`;
    await db.transaction((tx) =>
      dispatch(tx, {
        verificationId: concurrentVerification,
        dispatchKey: `${concurrentVerification}:initial:1`,
        state: 'rejected',
      }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        db.transaction((tx) =>
          dispatch(tx, {
            verificationId: concurrentVerification,
            generation: 2,
            dispatchKey: `${concurrentVerification}:initial:2`,
          }),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ cause: { code: '23505' } });
  });
});
