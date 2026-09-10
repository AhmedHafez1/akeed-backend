import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { CreditTransaction } from '../../infrastructure/database/credit-transaction';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../../infrastructure/database/database.provider';
import { CreditAccountingRepository } from '../../infrastructure/database/repositories/credit-accounting.repository';
import {
  adminAccessAudit,
  creditAccounts,
  creditLedgerEntries,
  creditReservations,
  integrations,
  organizations,
  paymentProviderEvents,
  paymentPurchases,
  verificationMessageDispatches,
} from '../../infrastructure/database/schema';
import {
  buildReconciliationReport,
  findContradictions,
} from './standalone-billing-operations.policy';
import type {
  PurchaseFact,
  ReconciliationReport,
  ReservationFact,
} from './standalone-billing-operations.types';

type Reader = DrizzleDB | CreditTransaction;

export const DETAIL_LIMITS = {
  ledger: 100,
  holds: 100,
  purchases: 50,
  events: 50,
  audit: 50,
} as const;
/** Enough anomalies to act on; a flood of them is one incident, not a list. */
const CONTRADICTION_SAMPLE = 50;

/**
 * Admin audit metadata fields a staff timeline may show. Anything else --
 * nested preview rows, source snapshots -- stays in the audit table.
 */
const AUDIT_SUMMARY_KEYS = [
  'reason',
  'evidence',
  'quantity',
  'resolution',
  'outcome',
  'resultCode',
  'errorCode',
  'reconciliationCode',
  'previewId',
  'dispatchId',
  'reference',
  'providerAction',
  'providerReference',
  'amountMinor',
  'currency',
  'grantedCredits',
  'postedBalanceBefore',
  'postedBalanceAfter',
  'heldCreditsBefore',
  'heldCreditsAfter',
  'postedDifference',
  'heldDifference',
  'reversalType',
  'reversalQuantity',
] as const;

/**
 * Read side of the staff billing console, plus the reconciliation facts the
 * write paths re-read under their locks.
 *
 * Every projection is explicit. The tables behind it carry request hashes,
 * event payload hashes and fingerprints that have no use to a person, and an
 * explicit list is what keeps a later column from joining the response.
 */
@Injectable()
export class StandaloneBillingOperationsRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly credits: CreditAccountingRepository,
  ) {}

  async readAccount(orgId: string, reader: Reader = this.db) {
    const [account] = await reader
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.orgId, orgId));
    return account;
  }

  /**
   * Ledger and hold totals against the projection, plus every contradiction
   * between source rows. Write paths call this inside their transaction after
   * taking the account lock, so what they check is what they change.
   */
  async readReconciliation(
    orgId: string,
    reader: Reader = this.db,
  ): Promise<ReconciliationReport | undefined> {
    const [invariant, reservations, purchases] = await Promise.all([
      this.credits.checkInvariant(orgId, reader),
      this.reservationFacts(orgId, reader),
      this.purchaseFacts(orgId, reader),
    ]);
    if (!invariant) return undefined;
    return buildReconciliationReport({
      postedBalance: invariant.postedBalance,
      heldCredits: invariant.heldCredits,
      ledgerBalance: Number(invariant.ledgerBalance),
      reservationHolds: Number(invariant.reservationHolds),
      contradictions: findContradictions(reservations, purchases),
    });
  }

  /**
   * Stores a staff preview as an audit row, the same way approval previews
   * are kept: the row id is the preview id, and apply can only ever read what
   * the server itself computed.
   */
  async savePreview(input: {
    userId: string;
    action: string;
    requestId?: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const [row] = await this.db
      .insert(adminAccessAudit)
      .values({
        userId: input.userId,
        action: input.action,
        outcome: 'allowed',
        requestId: input.requestId,
        metadata: { version: 1, ...input.metadata },
      })
      .returning({ id: adminAccessAudit.id });
    return row.id;
  }

  /** A preview only its own author can apply. */
  async readPreview(
    previewId: string,
    userId: string,
    action: string,
  ): Promise<Record<string, unknown> | undefined> {
    const [row] = await this.db
      .select({ metadata: adminAccessAudit.metadata })
      .from(adminAccessAudit)
      .where(
        and(
          eq(adminAccessAudit.id, previewId),
          eq(adminAccessAudit.userId, userId),
          eq(adminAccessAudit.action, action),
        ),
      );
    const metadata = row?.metadata;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  }

  /** The audit row an earlier apply wrote for this preview, if any. */
  async findApplied(
    tx: CreditTransaction,
    action: string,
    field: 'previewId' | 'ledgerEntryId',
    value: string,
  ) {
    const [row] = await tx
      .select({
        id: adminAccessAudit.id,
        metadata: adminAccessAudit.metadata,
        createdAt: adminAccessAudit.createdAt,
      })
      .from(adminAccessAudit)
      .where(
        and(
          eq(adminAccessAudit.action, action),
          sql`${adminAccessAudit}.metadata->>${field} = ${value}`,
        ),
      )
      .limit(1);
    return row
      ? {
          ...row,
          metadata: (row.metadata ?? {}) as Record<string, unknown>,
        }
      : undefined;
  }

  async insertAudit(
    writer: Reader,
    input: {
      userId: string;
      action: string;
      requestId?: string;
      targetIntegrationId?: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<string> {
    const [row] = await writer
      .insert(adminAccessAudit)
      .values({
        userId: input.userId,
        action: input.action,
        outcome: 'allowed',
        requestId: input.requestId,
        targetIntegrationId: input.targetIntegrationId,
        metadata: { version: 1, ...input.metadata },
      })
      .returning({ id: adminAccessAudit.id });
    return row.id;
  }

  async ledgerCount(orgId: string, reader: Reader = this.db) {
    const [row] = await reader
      .select({ count: sql<number>`count(*)::int` })
      .from(creditLedgerEntries)
      .where(eq(creditLedgerEntries.orgId, orgId));
    return Number(row?.count ?? 0);
  }

  /** Locks every held reservation, so the count repair writes cannot move. */
  async lockHeldReservations(tx: CreditTransaction, orgId: string) {
    return tx
      .select({
        id: creditReservations.id,
        quantity: creditReservations.quantity,
      })
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.orgId, orgId),
          eq(creditReservations.status, 'held'),
        ),
      )
      .for('update');
  }

  /**
   * Only the reservations that disagree with their ledger entries or their
   * dispatch, so a healthy account with a long send history reads nothing.
   */
  private async reservationFacts(
    orgId: string,
    reader: Reader,
  ): Promise<ReservationFact[]> {
    const consumed = sql<boolean>`EXISTS (SELECT 1 FROM ${creditLedgerEntries} AS entry WHERE entry.reservation_id = ${creditReservations}.id AND entry.type = 'consumption')`;
    const reversed = sql<boolean>`EXISTS (SELECT 1 FROM ${creditLedgerEntries} AS entry WHERE entry.reservation_id = ${creditReservations}.id AND entry.type = 'failure_reversal')`;
    const rows = await reader
      .select({
        reservationId: creditReservations.id,
        status: creditReservations.status,
        dispatchState: verificationMessageDispatches.state,
        consumed,
        reversed,
      })
      .from(creditReservations)
      .leftJoin(
        verificationMessageDispatches,
        eq(verificationMessageDispatches.id, creditReservations.dispatchId),
      )
      .where(
        and(
          eq(creditReservations.orgId, orgId),
          sql`(
            (${creditReservations}.status = 'held' AND (${consumed} OR ${reversed} OR ${verificationMessageDispatches}.state IN ('accepted', 'rejected')))
            OR (${creditReservations}.status = 'consumed' AND (NOT ${consumed} OR ${reversed}))
            OR (${creditReservations}.status = 'released' AND ${consumed} <> ${reversed})
          )`,
        ),
      )
      .limit(CONTRADICTION_SAMPLE);
    return rows.map((row) => ({
      ...row,
      dispatchState: row.dispatchState ?? null,
      consumed: Boolean(row.consumed),
      reversed: Boolean(row.reversed),
    }));
  }

  private async purchaseFacts(
    orgId: string,
    reader: Reader,
  ): Promise<PurchaseFact[]> {
    const granted = sql<boolean>`EXISTS (SELECT 1 FROM ${creditLedgerEntries} AS entry WHERE entry.purchase_id = ${paymentPurchases}.id AND entry.type = 'purchase')`;
    const netReversed = sql<number>`(SELECT COALESCE(-sum(entry.quantity), 0)::int FROM ${creditLedgerEntries} AS entry WHERE entry.purchase_id = ${paymentPurchases}.id AND entry.type IN ('refund_reversal', 'chargeback_reversal', 'chargeback_reinstatement'))`;
    const rows = await reader
      .select({
        reference: paymentPurchases.reference,
        status: paymentPurchases.status,
        quantity: paymentPurchases.quantity,
        granted,
        netReversed,
      })
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, orgId),
          sql`(
            ${granted} <> (${paymentPurchases}.status IN ('successful', 'refunded'))
            OR ${netReversed} > ${paymentPurchases}.quantity
            OR ${netReversed} < 0
          )`,
        ),
      )
      .limit(CONTRADICTION_SAMPLE);
    return rows.map((row) => ({
      ...row,
      granted: Boolean(row.granted),
      netReversed: Number(row.netReversed),
    }));
  }

  async readDetail(orgId: string) {
    const [organization] = await this.db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    const account = await this.readAccount(orgId);
    if (!organization && !account) return undefined;
    const [reconciliation, ledger, holds, purchases, events, audit] =
      await Promise.all([
        // An organization provisioned before credit billing has no account, and
        // so nothing to reconcile; its history reads come back empty.
        account ? this.readReconciliation(orgId) : undefined,
        this.ledger(orgId),
        this.holds(orgId),
        this.purchases(orgId),
        this.events(orgId),
        this.audit(orgId),
      ]);
    return {
      organization: organization ?? null,
      account: account ?? null,
      reconciliation,
      ledger,
      holds,
      purchases,
      events,
      audit,
    };
  }

  private async ledger(orgId: string) {
    const rows = await this.db
      .select({
        id: creditLedgerEntries.id,
        type: creditLedgerEntries.type,
        quantity: creditLedgerEntries.quantity,
        reason: creditLedgerEntries.reason,
        actorId: creditLedgerEntries.actorId,
        purchaseRef: paymentPurchases.reference,
        dispatchId: creditLedgerEntries.dispatchId,
        reservationId: creditLedgerEntries.reservationId,
        sourceLedgerEntryId: creditLedgerEntries.sourceLedgerEntryId,
        sourceReference: creditLedgerEntries.sourceReference,
        postedBalanceBefore: creditLedgerEntries.postedBalanceBefore,
        postedBalanceAfter: creditLedgerEntries.postedBalanceAfter,
        createdAt: creditLedgerEntries.createdAt,
      })
      .from(creditLedgerEntries)
      .leftJoin(
        paymentPurchases,
        and(
          eq(paymentPurchases.id, creditLedgerEntries.purchaseId),
          eq(paymentPurchases.orgId, creditLedgerEntries.orgId),
        ),
      )
      .where(eq(creditLedgerEntries.orgId, orgId))
      .orderBy(
        desc(creditLedgerEntries.createdAt),
        desc(creditLedgerEntries.id),
      )
      .limit(DETAIL_LIMITS.ledger + 1);
    return page(rows, DETAIL_LIMITS.ledger);
  }

  /** Held reservations with just enough of their send to decide on them. */
  private async holds(orgId: string) {
    const rows = await this.db
      .select({
        reservationId: creditReservations.id,
        dispatchId: creditReservations.dispatchId,
        verificationId: creditReservations.verificationId,
        kind: creditReservations.kind,
        generation: creditReservations.generation,
        quantity: creditReservations.quantity,
        createdAt: creditReservations.createdAt,
        dispatchState: verificationMessageDispatches.state,
        accountingMode: verificationMessageDispatches.accountingMode,
        attemptCount: verificationMessageDispatches.attemptCount,
        lastErrorCode: verificationMessageDispatches.lastErrorCode,
        // Whether a provider id was salvaged, not the id: staff resolving a
        // send must bring the id from the provider's own records.
        providerMessageIdRecorded: sql<boolean>`${verificationMessageDispatches}.provider_message_id IS NOT NULL`,
        leaseUntil: verificationMessageDispatches.leaseUntil,
      })
      .from(creditReservations)
      .leftJoin(
        verificationMessageDispatches,
        and(
          eq(verificationMessageDispatches.id, creditReservations.dispatchId),
          eq(verificationMessageDispatches.orgId, creditReservations.orgId),
        ),
      )
      .where(
        and(
          eq(creditReservations.orgId, orgId),
          eq(creditReservations.status, 'held'),
        ),
      )
      .orderBy(creditReservations.createdAt, creditReservations.id)
      .limit(DETAIL_LIMITS.holds + 1);
    return page(
      rows.map((row) => ({
        ...row,
        providerMessageIdRecorded: Boolean(row.providerMessageIdRecorded),
      })),
      DETAIL_LIMITS.holds,
    );
  }

  private async purchases(orgId: string) {
    const rows = await this.db
      .select({
        reference: paymentPurchases.reference,
        provider: paymentPurchases.provider,
        mode: paymentPurchases.mode,
        status: paymentPurchases.status,
        disputeStatus: paymentPurchases.disputeStatus,
        quantity: paymentPurchases.quantity,
        unitPriceMinor: paymentPurchases.unitPriceMinor,
        totalMinor: paymentPurchases.totalMinor,
        currency: paymentPurchases.currency,
        refundedMinor: paymentPurchases.refundedMinor,
        providerOrderId: paymentPurchases.providerOrderId,
        providerTransactionId: paymentPurchases.providerTransactionId,
        checkoutExpiresAt: paymentPurchases.checkoutExpiresAt,
        reconciliationRequired: paymentPurchases.reconciliationRequired,
        reconciliationCode: paymentPurchases.reconciliationCode,
        reconciliationAttempts: paymentPurchases.reconciliationAttempts,
        nextReconciliationAt: paymentPurchases.nextReconciliationAt,
        createdAt: paymentPurchases.createdAt,
        updatedAt: paymentPurchases.updatedAt,
      })
      .from(paymentPurchases)
      .where(eq(paymentPurchases.orgId, orgId))
      .orderBy(desc(paymentPurchases.createdAt), desc(paymentPurchases.id))
      .limit(DETAIL_LIMITS.purchases + 1);
    return page(rows, DETAIL_LIMITS.purchases);
  }

  /** Outcome summaries only; the payload hash and fingerprint stay behind. */
  private async events(orgId: string) {
    const rows = await this.db
      .select({
        id: paymentProviderEvents.id,
        provider: paymentProviderEvents.provider,
        purchaseRef: paymentPurchases.reference,
        verified: paymentProviderEvents.verified,
        resultCode: paymentProviderEvents.resultCode,
        errorCode: paymentProviderEvents.errorCode,
        receivedAt: paymentProviderEvents.receivedAt,
        processedAt: paymentProviderEvents.processedAt,
      })
      .from(paymentProviderEvents)
      .leftJoin(
        paymentPurchases,
        and(
          eq(paymentPurchases.id, paymentProviderEvents.purchaseId),
          eq(paymentPurchases.orgId, paymentProviderEvents.orgId),
        ),
      )
      .where(eq(paymentProviderEvents.orgId, orgId))
      .orderBy(
        desc(paymentProviderEvents.receivedAt),
        desc(paymentProviderEvents.id),
      )
      .limit(DETAIL_LIMITS.events + 1);
    return page(rows, DETAIL_LIMITS.events);
  }

  /**
   * Staff actions on this organization: everything the billing console wrote
   * with the organization id, and dispatch resolutions against its sources.
   */
  private async audit(orgId: string) {
    const rows = await this.db
      .select({
        id: adminAccessAudit.id,
        action: adminAccessAudit.action,
        outcome: adminAccessAudit.outcome,
        actorId: adminAccessAudit.userId,
        requestId: adminAccessAudit.requestId,
        metadata: adminAccessAudit.metadata,
        createdAt: adminAccessAudit.createdAt,
      })
      .from(adminAccessAudit)
      .where(
        or(
          sql`${adminAccessAudit}.metadata->>'orgId' = ${orgId}`,
          and(
            eq(adminAccessAudit.action, 'message-dispatch.resolve'),
            sql`${adminAccessAudit}.target_integration_id IN (SELECT source.id FROM ${integrations} AS source WHERE source.org_id = ${orgId})`,
          ),
        ),
      )
      .orderBy(desc(adminAccessAudit.createdAt), desc(adminAccessAudit.id))
      .limit(DETAIL_LIMITS.audit + 1);
    return page(
      rows.map(({ metadata, ...row }) => ({
        ...row,
        summary: summarizeAudit(metadata),
      })),
      DETAIL_LIMITS.audit,
    );
  }
}

function page<T>(rows: T[], limit: number) {
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

export function summarizeAudit(
  metadata: unknown,
): Record<string, string | number | boolean | null> {
  if (!metadata || typeof metadata !== 'object') return {};
  const source = metadata as Record<string, unknown>;
  const summary: Record<string, string | number | boolean | null> = {};
  for (const key of AUDIT_SUMMARY_KEYS) {
    const value = source[key];
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= 1000)
    )
      summary[key] = value;
  }
  return summary;
}
