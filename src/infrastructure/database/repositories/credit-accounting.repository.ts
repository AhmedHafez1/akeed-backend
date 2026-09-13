import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  CreditAccountStatus,
  CreditLedgerType,
  CreditSummary,
} from '../../../shared/ports/credit-accounting.port';
import type { CreditTransaction, CreditWriter } from '../credit-transaction';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  creditAccounts,
  creditLedgerEntries,
  creditReservations,
  verificationMessageDispatches,
  integrations,
} from '../schema';

export interface CreditInvariantReport {
  orgId: string;
  postedBalance: number;
  heldCredits: number;
  ledgerBalance: string;
  reservationHolds: string;
  consistent: boolean;
}

export class CreditInvariantError extends Error {
  constructor(readonly report: CreditInvariantReport) {
    super(`Credit projection mismatch for organization ${report.orgId}`);
  }
}

export class CreditVersionConflictError extends Error {
  constructor() {
    super('Credit account version changed or account was not found');
  }
}

export function buildFreeGrantKey(orgId: string): string {
  return `standalone-free-grant:${orgId}:v1`;
}

const SIGNUP_FREE_GRANT_REASON = 'signup_auto_activation';

export interface ActiveCreditAccountSeed {
  /** The merchant whose verified signup activates the account. */
  actorId: string;
  freeGrant: number;
}

/**
 * Opens a Standalone organization's credit account already active, with its
 * one-time launch grant posted in the same statement pair. The account row and
 * its ledger entry are only written when the row is new, so re-provisioning
 * never grants twice; `credit_ledger_free_grant_key` backs that up.
 *
 * Exposed as a free function so the provisioning transaction, which has no
 * container to inject a repository from, writes it through the same statements.
 */
export async function ensureActiveCreditAccount(
  tx: CreditWriter,
  orgId: string,
  seed: ActiveCreditAccountSeed,
): Promise<void> {
  const [inserted] = await tx
    .insert(creditAccounts)
    .values({ orgId, status: 'active', postedBalance: seed.freeGrant })
    .onConflictDoNothing()
    .returning({ orgId: creditAccounts.orgId });
  if (!inserted) return;
  await tx.insert(creditLedgerEntries).values({
    orgId,
    type: 'free_grant',
    quantity: seed.freeGrant,
    idempotencyKey: buildFreeGrantKey(orgId),
    actorId: seed.actorId,
    reason: SIGNUP_FREE_GRANT_REASON,
    postedBalanceBefore: 0,
    postedBalanceAfter: seed.freeGrant,
  });
}

type Account = typeof creditAccounts.$inferSelect;
type Reservation = typeof creditReservations.$inferInsert;
type LedgerEntry = typeof creditLedgerEntries.$inferInsert;
type CreditLedgerEntry = typeof creditLedgerEntries.$inferSelect;

@Injectable()
export class CreditAccountingRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async getSummary(orgId: string): Promise<CreditSummary | undefined> {
    const [account] = await this.db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, orgId));
    return account ? this.summary(account) : undefined;
  }

  async hasUnresolvedLegacySends(orgId: string): Promise<boolean> {
    const [legacy] = await this.db
      .select({ id: verificationMessageDispatches.id })
      .from(verificationMessageDispatches)
      .innerJoin(
        integrations,
        eq(integrations.id, verificationMessageDispatches.integrationId),
      )
      .where(
        and(
          eq(integrations.platformType, 'standalone'),
          eq(verificationMessageDispatches.orgId, orgId),
          eq(verificationMessageDispatches.accountingMode, 'periodic_plan'),
          inArray(verificationMessageDispatches.state, [
            'sending',
            'outcome_unknown',
          ]),
        ),
      )
      .limit(1);
    return Boolean(legacy);
  }

  summary(account: Account): CreditSummary {
    return {
      orgId: account.orgId,
      status: account.status,
      postedBalance: account.postedBalance,
      heldCredits: account.heldCredits,
      availableCredits: Math.max(
        account.postedBalance - account.heldCredits,
        0,
      ),
      debtCredits: Math.max(-account.postedBalance, 0),
      version: account.version,
    };
  }

  /**
   * Both subqueries alias their table and qualify the outer column. Drizzle
   * renders a column reference inside a select-list `sql` fragment unqualified,
   * which turned `WHERE org_id = org_id` into a tautology and summed every
   * organization's ledger into every account's report.
   */
  async checkInvariant(
    orgId: string,
    reader: DrizzleDB | CreditTransaction = this.db,
  ): Promise<CreditInvariantReport | undefined> {
    const [report] = await reader
      .select({
        orgId: creditAccounts.orgId,
        postedBalance: creditAccounts.postedBalance,
        heldCredits: creditAccounts.heldCredits,
        ledgerBalance: sql<string>`(SELECT COALESCE(sum(entry.quantity), 0)::text FROM ${creditLedgerEntries} AS entry WHERE entry.org_id = ${creditAccounts}.org_id)`,
        reservationHolds: sql<string>`(SELECT COALESCE(sum(reservation.quantity), 0)::text FROM ${creditReservations} AS reservation WHERE reservation.org_id = ${creditAccounts}.org_id AND reservation.status = 'held')`,
      })
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, orgId));
    if (!report) return undefined;
    return {
      ...report,
      consistent:
        BigInt(report.ledgerBalance) === BigInt(report.postedBalance) &&
        BigInt(report.reservationHolds) === BigInt(report.heldCredits),
    };
  }

  async lockAccount(tx: CreditTransaction, orgId: string): Promise<Account> {
    const [account] = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, orgId))
      .for('update');
    if (!account) throw new Error('Credit account not found');
    const report = await this.checkInvariant(orgId, tx);
    if (!report || !report.consistent) {
      if (report) throw new CreditInvariantError(report);
      throw new Error('Credit account not found');
    }
    return account;
  }

  /**
   * Locks the account without demanding that it adds up.
   *
   * Only projection repair may take this path: every other writer must refuse
   * an account whose projection has drifted from its ledger, and repair is the
   * one operation whose purpose is to bring it back.
   */
  async lockAccountForRepair(
    tx: CreditTransaction,
    orgId: string,
  ): Promise<Account | undefined> {
    const [account] = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, orgId))
      .for('update');
    return account;
  }

  async assertConsistent(tx: CreditTransaction, orgId: string): Promise<void> {
    const report = await this.checkInvariant(orgId, tx);
    if (!report?.consistent)
      throw new CreditInvariantError(
        report ?? {
          orgId,
          postedBalance: 0,
          heldCredits: 0,
          ledgerBalance: '0',
          reservationHolds: '0',
          consistent: false,
        },
      );
  }

  /**
   * Posts one balance change.
   *
   * The ledger entry, the projection update and the invariant re-check happen
   * in the caller's transaction under the account lock, and the before/after
   * balances are read from the locked row -- never supplied by a caller -- so
   * `credit_ledger_projection_check` and the projection cannot disagree.
   */
  async postLedgerEntry(
    tx: CreditTransaction,
    input: Omit<LedgerEntry, 'postedBalanceBefore' | 'postedBalanceAfter'>,
    locked?: Account,
  ): Promise<{ entry: CreditLedgerEntry; before: Account; after: Account }> {
    if (locked && locked.orgId !== input.orgId)
      throw new Error('Ledger posting does not match the locked account');
    const before = locked ?? (await this.lockAccount(tx, input.orgId));
    const postedBalance = before.postedBalance + input.quantity;
    const entry = await this.insertLedgerEntry(tx, {
      ...input,
      postedBalanceBefore: before.postedBalance,
      postedBalanceAfter: postedBalance,
    });
    const after = await this.updateProjection(tx, {
      orgId: input.orgId,
      expectedVersion: before.version,
      postedBalance,
      heldCredits: before.heldCredits,
    });
    await this.assertConsistent(tx, input.orgId);
    return { entry, before, after };
  }

  /**
   * The account's version trigger demands exactly one increment per update, so
   * a status change has to travel with the projection it belongs to rather
   * than following it in a second statement.
   */
  async updateProjection(
    tx: CreditTransaction,
    input: {
      orgId: string;
      expectedVersion: number;
      postedBalance: number;
      heldCredits: number;
      status?: CreditAccountStatus;
    },
  ): Promise<Account> {
    const [account] = await tx
      .update(creditAccounts)
      .set({
        postedBalance: input.postedBalance,
        heldCredits: input.heldCredits,
        ...(input.status ? { status: input.status } : {}),
        version: sql`${creditAccounts.version} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(creditAccounts.orgId, input.orgId),
          eq(creditAccounts.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!account) throw new CreditVersionConflictError();
    return account;
  }

  async insertLedgerEntry(tx: CreditTransaction, input: LedgerEntry) {
    const [entry] = await tx
      .insert(creditLedgerEntries)
      .values(input)
      .returning();
    return entry;
  }

  async findLedgerEntry(
    tx: CreditTransaction,
    orgId: string,
    idempotencyKey: string,
  ) {
    const [entry] = await tx
      .select()
      .from(creditLedgerEntries)
      .where(
        and(
          eq(creditLedgerEntries.orgId, orgId),
          eq(creditLedgerEntries.idempotencyKey, idempotencyKey),
        ),
      );
    return entry;
  }

  /**
   * The ledger entry a reversal must point at.
   *
   * `guard_credit_ledger_source` refuses a reversal whose source is the wrong
   * type, belongs to another purchase, or -- for a reinstatement -- does not
   * carry the same `source_reference` and the exactly opposite quantity. So the
   * source is looked up rather than assumed.
   */
  async findPurchaseLedgerEntry(
    tx: CreditTransaction,
    orgId: string,
    purchaseId: string,
    type: CreditLedgerType,
    sourceReference?: string,
  ) {
    const [entry] = await tx
      .select()
      .from(creditLedgerEntries)
      .where(
        and(
          eq(creditLedgerEntries.orgId, orgId),
          eq(creditLedgerEntries.purchaseId, purchaseId),
          eq(creditLedgerEntries.type, type),
          sourceReference
            ? eq(creditLedgerEntries.sourceReference, sourceReference)
            : undefined,
        ),
      )
      .limit(1);
    return entry;
  }

  /**
   * How many credits this purchase has already had taken back or returned,
   * split by cause so a chargeback win reinstates only what the chargeback
   * took and leaves a refund reversed.
   */
  async readPurchaseReversals(
    tx: CreditTransaction,
    orgId: string,
    purchaseId: string,
  ) {
    const rows = await tx
      .select({
        type: creditLedgerEntries.type,
        total: sql<string>`COALESCE(sum(abs(${creditLedgerEntries.quantity})), 0)::text`,
      })
      .from(creditLedgerEntries)
      .where(
        and(
          eq(creditLedgerEntries.orgId, orgId),
          eq(creditLedgerEntries.purchaseId, purchaseId),
          inArray(creditLedgerEntries.type, [
            'refund_reversal',
            'chargeback_reversal',
            'chargeback_reinstatement',
          ]),
        ),
      )
      .groupBy(creditLedgerEntries.type);
    const total = (type: CreditLedgerType) =>
      Number(rows.find((row) => row.type === type)?.total ?? 0);
    return {
      refundReversedCredits: total('refund_reversal'),
      chargebackReversedCredits: total('chargeback_reversal'),
      chargebackReinstatedCredits: total('chargeback_reinstatement'),
    };
  }

  async insertReservation(tx: CreditTransaction, input: Reservation) {
    const [reservation] = await tx
      .insert(creditReservations)
      .values(input)
      .returning();
    return reservation;
  }

  async lockReservation(
    tx: CreditTransaction,
    orgId: string,
    billableKey: string,
  ) {
    const [reservation] = await tx
      .select()
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.orgId, orgId),
          eq(creditReservations.billableKey, billableKey),
        ),
      )
      .for('update');
    return reservation;
  }

  async resolveReservation(
    tx: CreditTransaction,
    orgId: string,
    reservationId: string,
    expectedStatus: 'held' | 'consumed',
    resolution: {
      status: 'consumed' | 'released';
      resolutionCode: string;
      resolvedBy?: string;
    },
  ) {
    const [reservation] = await tx
      .update(creditReservations)
      .set({
        ...resolution,
        resolvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.orgId, orgId),
          eq(creditReservations.status, expectedStatus),
        ),
      )
      .returning();
    if (!reservation) throw new Error('Credit reservation state conflict');
    return reservation;
  }
}
