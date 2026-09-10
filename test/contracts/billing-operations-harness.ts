import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as tables from '../../src/infrastructure/database/schema';
import { VerificationMessageDispatchesRepository } from '../../src/infrastructure/database/repositories/verification-message-dispatches.repository';
import { StandaloneBillingRepository } from '../../src/modules/admin/standalone-billing.repository';
import { StandaloneBillingService } from '../../src/modules/admin/standalone-billing.service';
import { StandaloneBillingOperationsRepository } from '../../src/modules/admin/standalone-billing-operations.repository';
import { StandaloneBillingOperationsService } from '../../src/modules/admin/standalone-billing-operations.service';
import { paymobBillingHarness } from './paymob-billing-harness';
import { standaloneCreditBillingConfigService } from './standalone-credit-billing-config';

export const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

/**
 * The Paymob billing harness plus everything the staff console reads and
 * drives: memberships and claims for the approval snapshot, the dispatch
 * repository for credit holds, and the admin services themselves.
 */
export function billingOperationsHarness() {
  const base = paymobBillingHarness({
    extraTables: [tables.memberships, tables.billingFreePlanClaims],
  });
  const { db, credits } = base;
  const config = standaloneCreditBillingConfigService({
    STANDALONE_CREDIT_BILLING_ENABLED: 'true',
    STANDALONE_BILLING_OPERATIONS_ENABLED: 'true',
    STANDALONE_BILLING_OPERATOR_IDS: OPERATOR,
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
  const dispatches = new VerificationMessageDispatchesRepository(
    db,
    base.router,
  );
  const approvals = new StandaloneBillingService(
    // The approval repository is typed against the schema barrel; the
    // tables and relations are the same.
    new StandaloneBillingRepository(db as never, credits),
    config,
  );
  const operationsRepository = new StandaloneBillingOperationsRepository(
    db,
    credits,
  );
  const operations = new StandaloneBillingOperationsService(
    db,
    operationsRepository,
    credits,
    config,
  );

  /** A pending verification the dispatch repository can claim a send for. */
  async function verification(source: {
    orgId: string;
    integrationId: string;
  }) {
    const [order] = await db
      .insert(tables.orders)
      .values({
        ...source,
        externalOrderId: randomUUID(),
        customerPhone: '+201000000000',
        totalPrice: '100.00',
      })
      .returning();
    const [row] = await db
      .insert(tables.verifications)
      .values({ orgId: source.orgId, orderId: order.id, status: 'pending' })
      .returning();
    return {
      ...source,
      verificationId: row.id,
      kind: 'initial' as const,
      templateName: 'cod_verification',
      languageCode: 'en',
      leaseUntil: new Date(Date.now() + 600000).toISOString(),
    };
  }

  /** A send whose provider call returned no message id: credit stays held. */
  async function ambiguousSend(source: {
    orgId: string;
    integrationId: string;
  }) {
    const input = await verification(source);
    const claimed = await dispatches.claim(input);
    if (claimed.outcome !== 'claimed')
      throw new Error(`Expected claim, received ${claimed.outcome}`);
    await dispatches.markFailedProviderOutcome(
      claimed.dispatch.id,
      'provider_timeout',
    );
    return { ...input, dispatchId: claimed.dispatch.id };
  }

  /**
   * Moves the projection away from its ledger the only way it can drift in
   * production: a statement that bypasses the posting path.
   */
  async function driftProjection(orgId: string, postedDelta: number) {
    await db
      .update(tables.creditAccounts)
      .set({
        postedBalance: sql`${tables.creditAccounts.postedBalance} + ${postedDelta}`,
        version: sql`${tables.creditAccounts.version} + 1`,
      })
      .where(eq(tables.creditAccounts.orgId, orgId));
  }

  async function account(orgId: string) {
    const [row] = await db
      .select()
      .from(tables.creditAccounts)
      .where(eq(tables.creditAccounts.orgId, orgId));
    return row;
  }

  async function auditRows(orgId: string) {
    return db
      .select()
      .from(tables.adminAccessAudit)
      .where(sql`${tables.adminAccessAudit}.metadata->>'orgId' = ${orgId}`);
  }

  return {
    ...base,
    config,
    dispatches,
    approvals,
    operationsRepository,
    operations,
    verification,
    ambiguousSend,
    driftProjection,
    account,
    auditRows,
  };
}
