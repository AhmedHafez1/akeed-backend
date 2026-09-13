import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as tables from '../../src/infrastructure/database/schema';
import * as relations from '../../src/infrastructure/database/relations';
import { CreditAccountingRepository } from '../../src/infrastructure/database/repositories/credit-accounting.repository';
import { PaymentPurchasesRepository } from '../../src/infrastructure/database/repositories/payment-purchases.repository';
import { PrepaidCreditAccounting } from '../../src/infrastructure/database/repositories/prepaid-credit-accounting';
import { PeriodicPlanAccounting } from '../../src/infrastructure/database/repositories/periodic-plan-accounting';
import { UsageAccountingRouter } from '../../src/infrastructure/database/repositories/usage-accounting.router';
import { BillingRepository } from '../../src/modules/billing/billing.repository';
import { BillingService } from '../../src/modules/billing/billing.service';
import { PaymentCallbackService } from '../../src/modules/billing/payment-callback.service';
import { PaymentReconciliationService } from '../../src/modules/billing/payment-reconciliation.service';
import { standaloneCreditBillingConfigService } from './standalone-credit-billing-config';
import { fakePaymentsPort } from './fake-payments-port';

/**
 * A disposable PostgreSQL schema carrying the real credit and payment tables,
 * with their real constraints and triggers.
 *
 * The point of the suite this backs is that most of the exactly-once and
 * fail-closed behaviour is enforced by the database, not by application code.
 * Mocking the database would test the wrong half.
 */
export function paymobBillingHarness(
  options: {
    /** Further tables a suite reads, scaffolded like the ones below. */
    extraTables?: PgTable[];
  } = {},
) {
  const value = process.env.E045_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'E045_TEST_DATABASE_URL is required; application DATABASE_URL is never used.',
    );
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/akeed_e045_test' ||
    url.username !== 'e045_test' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use local PostgreSQL, database akeed_e045_test, user e045_test, without query parameters.',
    );

  const namespace = `e045_paymob_${randomUUID().replaceAll('-', '')}`;
  const client = postgres(value, {
    max: 8,
    onnotice: () => undefined,
    connection: { search_path: `${namespace},public` },
  });
  const db = drizzle(client, { schema: { ...tables, ...relations } });

  const credits = new CreditAccountingRepository(db);
  const purchases = new PaymentPurchasesRepository(db);
  const billingRepository = new BillingRepository(db);
  const prepaid = new PrepaidCreditAccounting(credits);
  const periodic = new PeriodicPlanAccounting();
  const config = standaloneCreditBillingConfigService({
    STANDALONE_CREDIT_BILLING_ENABLED: 'true',
    PAYMOB_MODE: 'test',
    PAYMOB_BASE_URL: 'http://localhost:9000',
    PAYMOB_CALLBACK_URL: 'http://localhost:9000/api/webhooks/payments/paymob',
    PAYMOB_RETURN_URL: 'http://localhost:9000',
    PAYMOB_SECRET_KEY: 'sandbox-secret',
    PAYMOB_PUBLIC_KEY: 'sandbox-public',
    PAYMOB_HMAC_SECRET: 'sandbox-hmac',
    PAYMOB_CARD_INTEGRATION_ID: 'card1',
    PAYMOB_WALLET_INTEGRATION_ID: 'wallet1',
    PAYMOB_CHECKOUT_EXPIRATION_SECONDS: '900',
  });
  const router = new UsageAccountingRouter(prepaid, periodic, config);
  const paymob = fakePaymentsPort();
  const callbacks = new PaymentCallbackService(db, config, credits, purchases);
  const reconciliation = new PaymentReconciliationService(
    db,
    purchases,
    callbacks,
    paymob,
  );
  const integrations = {
    findActiveByOrg: (orgId: string) =>
      db
        .select()
        .from(tables.integrations)
        .where(eq(tables.integrations.orgId, orgId)),
    findByOrg: (orgId: string) =>
      db
        .select()
        .from(tables.integrations)
        .where(eq(tables.integrations.orgId, orgId)),
  };
  const billing = new BillingService(
    db,
    config,
    credits,
    purchases,
    billingRepository,
    integrations as never,
    reconciliation,
    paymob,
  );

  async function scaffold(table: PgTable) {
    const definition = getTableConfig(table);
    const dialect = new PgDialect();
    const columns = definition.columns.map((column) => {
      let result = `"${column.name}" ${column.getSQLType()}`;
      if (column.notNull) result += ' NOT NULL';
      if (column.primary) result += ' PRIMARY KEY';
      if (column.default !== undefined) {
        const defaultValue = column.default;
        result +=
          ' DEFAULT ' +
          (defaultValue instanceof SQL
            ? dialect.sqlToQuery(defaultValue).sql
            : typeof defaultValue === 'boolean' ||
                typeof defaultValue === 'number'
              ? String(defaultValue)
              : `'${(typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue)).replaceAll("'", "''")}'`);
      }
      return result;
    });
    for (const unique of definition.uniqueConstraints)
      columns.push(
        `UNIQUE (${unique.columns.map((column) => `"${column.name}"`).join(', ')})`,
      );
    await client.unsafe(
      `CREATE TABLE "${definition.name}" (${columns.join(', ')})`,
    );
  }

  async function migrate(name: string) {
    const statements = readFileSync(
      resolve(__dirname, '../../drizzle', name),
      'utf8',
    )
      .replaceAll('"public"', `"${namespace}"`)
      .replaceAll("'public.", `'${namespace}.`)
      .replaceAll("'public'", `'${namespace}'`)
      .split('--> statement-breakpoint')
      .filter((part) => part.trim());
    await client.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });
  }

  async function setup() {
    await client`CREATE SCHEMA ${client(namespace)}`;
    await client.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE FUNCTION get_user_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.org_id', true), '')::uuid $$;`);
    for (const candidate of Object.values(tables)) {
      if (
        typeof candidate === 'function' &&
        'enumName' in candidate &&
        'enumValues' in candidate &&
        !String(candidate.enumName).startsWith('credit_') &&
        !String(candidate.enumName).startsWith('payment_')
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
      tables.integrationMonthlyUsage,
      tables.adminAccessAudit,
      tables.webhookEvents,
      // 0035 reads ownership and billing history when it activates accounts.
      tables.memberships,
      tables.billingFreePlanClaims,
      ...(options.extraTables ?? []).filter(
        (table) =>
          table !== tables.memberships &&
          table !== tables.billingFreePlanClaims,
      ),
    ])
      await scaffold(table);
    const dispatchDdl = readFileSync(
      resolve(
        __dirname,
        '../../drizzle/0028_manual_order_lifecycle_dispatch_ledger.sql',
      ),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .find((part) =>
        part.includes(
          'CREATE TABLE IF NOT EXISTS "public"."verification_message_dispatches"',
        ),
      )!;
    await client.unsafe(dispatchDdl.replaceAll('"public".', `"${namespace}".`));
    // The real migrations, so every CHECK, unique index and trigger this suite
    // relies on is the one production will have.
    await migrate('0032_credit_and_payment_domain_foundation.sql');
    await migrate('0033_dispatch_accounting_mode.sql');
    await migrate('0034_billing_observability_and_settlements.sql');
    await migrate('0035_standalone_auto_activation.sql');
  }

  /** An active Standalone merchant holding `quantity` granted credits. */
  async function merchant(quantity = 30, platformType = 'standalone') {
    const orgId = randomUUID();
    await db
      .insert(tables.organizations)
      .values({ id: orgId, name: 'Synthetic billing merchant', slug: orgId });
    const [integration] = await db
      .insert(tables.integrations)
      .values({
        orgId,
        platformType,
        platformStoreUrl: orgId,
        isActive: true,
        ...(platformType === 'shopify'
          ? {
              billingStatus: 'active',
              billingPlanId: 'starter',
              billingActivatedAt: '2026-09-01T00:00:00Z',
            }
          : {}),
      })
      .returning();
    if (platformType === 'standalone')
      await db.transaction(async (tx) => {
        await tx
          .insert(tables.creditAccounts)
          .values({ orgId })
          .onConflictDoNothing();
        const account = await credits.lockAccount(tx, orgId);
        if (quantity > 0)
          await credits.insertLedgerEntry(tx, {
            orgId,
            type: 'free_grant',
            quantity,
            idempotencyKey: `fixture:${orgId}`,
            actorId: randomUUID(),
            reason: 'Synthetic opening fixture',
            postedBalanceBefore: 0,
            postedBalanceAfter: quantity,
          });
        await credits.updateProjection(tx, {
          orgId,
          expectedVersion: account.version,
          postedBalance: quantity,
          heldCredits: 0,
          status: 'active',
        });
      });
    return {
      orgId,
      integrationId: integration.id,
      user: {
        userId: randomUUID(),
        source: 'supabase' as const,
        orgId,
        role: 'owner' as const,
      },
    };
  }

  async function balance(orgId: string, posted: number) {
    expect(await credits.getSummary(orgId)).toMatchObject({
      postedBalance: posted,
    });
    expect(await credits.checkInvariant(orgId)).toMatchObject({
      consistent: true,
    });
  }

  async function ledger(orgId: string) {
    return db
      .select()
      .from(tables.creditLedgerEntries)
      .where(eq(tables.creditLedgerEntries.orgId, orgId));
  }

  async function events(reference: string) {
    const [purchase] = await db
      .select({ id: tables.paymentPurchases.id })
      .from(tables.paymentPurchases)
      .where(eq(tables.paymentPurchases.reference, reference));
    return db
      .select()
      .from(tables.paymentProviderEvents)
      .where(eq(tables.paymentProviderEvents.purchaseId, purchase?.id ?? ''));
  }

  async function purchaseRow(reference: string) {
    const [purchase] = await db
      .select()
      .from(tables.paymentPurchases)
      .where(eq(tables.paymentPurchases.reference, reference));
    return purchase;
  }

  async function teardown() {
    await client`DROP SCHEMA IF EXISTS ${client(namespace)} CASCADE`;
    await client.end();
  }

  return {
    client,
    db,
    namespace,
    config,
    credits,
    purchases,
    router,
    paymob,
    billing,
    callbacks,
    reconciliation,
    setup,
    teardown,
    merchant,
    balance,
    ledger,
    events,
    purchaseRow,
  };
}
