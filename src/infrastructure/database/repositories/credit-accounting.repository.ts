import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  CreditAccountStatus,
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

/**
 * Seeds the pending account a Standalone organization is approved from. Exposed
 * as a free function so the provisioning transaction, which has no container to
 * inject a repository from, writes it through the same statement staff paths do.
 */
export async function ensurePendingCreditAccount(
  tx: CreditWriter,
  orgId: string,
): Promise<void> {
  await tx.insert(creditAccounts).values({ orgId }).onConflictDoNothing();
}

type Account = typeof creditAccounts.$inferSelect;
type Reservation = typeof creditReservations.$inferInsert;
type LedgerEntry = typeof creditLedgerEntries.$inferInsert;

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

  async ensurePendingAccount(tx: CreditWriter, orgId: string): Promise<void> {
    await ensurePendingCreditAccount(tx, orgId);
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
   * The account's version trigger demands exactly one increment per update, so
   * a status or approval change has to travel with the projection it belongs
   * to rather than following it in a second statement.
   */
  async updateProjection(
    tx: CreditTransaction,
    input: {
      orgId: string;
      expectedVersion: number;
      postedBalance: number;
      heldCredits: number;
      status?: CreditAccountStatus;
      approval?: { approvedBy: string; approvedAt: string; reason: string };
    },
  ): Promise<Account> {
    const [account] = await tx
      .update(creditAccounts)
      .set({
        postedBalance: input.postedBalance,
        heldCredits: input.heldCredits,
        ...(input.status ? { status: input.status } : {}),
        ...(input.approval
          ? {
              approvedBy: input.approval.approvedBy,
              approvedAt: input.approval.approvedAt,
              approvalReason: input.approval.reason,
            }
          : {}),
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
