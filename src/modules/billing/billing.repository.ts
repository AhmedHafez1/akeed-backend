import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../../infrastructure/database/database.provider';
import {
  creditLedgerEntries,
  paymentPurchases,
} from '../../infrastructure/database/schema';
import type { CreditLedgerType } from '../../shared/ports/credit-accounting.port';
import type { HistoryCursor } from './billing.policy';

/**
 * Read-side queries for the merchant billing pages.
 *
 * Every projection is explicit rather than `select *`. The ledger and purchase
 * rows carry internal identifiers -- dispatch keys, request hashes, provider
 * ids, staff actor ids -- that have no business reaching a browser, and an
 * explicit column list is the only thing that keeps a later column addition
 * from leaking one by default.
 */
@Injectable()
export class BillingRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Keyset page over `credit_ledger_history_idx (org_id, created_at, id)`.
   *
   * Keyset rather than offset because the ledger grows while a merchant reads
   * it, and an offset page would silently repeat or skip entries.
   */
  async listLedger(input: {
    orgId: string;
    limit: number;
    cursor: HistoryCursor | null;
    type?: CreditLedgerType;
  }) {
    return this.db
      .select({
        id: creditLedgerEntries.id,
        type: creditLedgerEntries.type,
        quantity: creditLedgerEntries.quantity,
        reason: creditLedgerEntries.reason,
        postedBalanceAfter: creditLedgerEntries.postedBalanceAfter,
        createdAt: creditLedgerEntries.createdAt,
        purchaseRef: paymentPurchases.reference,
      })
      .from(creditLedgerEntries)
      .leftJoin(
        paymentPurchases,
        and(
          eq(paymentPurchases.id, creditLedgerEntries.purchaseId),
          eq(paymentPurchases.orgId, creditLedgerEntries.orgId),
        ),
      )
      .where(
        and(
          eq(creditLedgerEntries.orgId, input.orgId),
          input.type ? eq(creditLedgerEntries.type, input.type) : undefined,
          keyset(
            creditLedgerEntries.createdAt,
            creditLedgerEntries.id,
            input.cursor,
          ),
        ),
      )
      .orderBy(
        desc(creditLedgerEntries.createdAt),
        desc(creditLedgerEntries.id),
      )
      .limit(input.limit + 1);
  }

  /** Keyset page over `payment_purchase_history_idx`. */
  async listPurchases(input: {
    orgId: string;
    limit: number;
    cursor: HistoryCursor | null;
  }) {
    return this.db
      .select({
        id: paymentPurchases.id,
        reference: paymentPurchases.reference,
        status: paymentPurchases.status,
        disputeStatus: paymentPurchases.disputeStatus,
        quantity: paymentPurchases.quantity,
        unitPriceMinor: paymentPurchases.unitPriceMinor,
        totalMinor: paymentPurchases.totalMinor,
        currency: paymentPurchases.currency,
        refundedMinor: paymentPurchases.refundedMinor,
        checkoutExpiresAt: paymentPurchases.checkoutExpiresAt,
        createdAt: paymentPurchases.createdAt,
      })
      .from(paymentPurchases)
      .where(
        and(
          eq(paymentPurchases.orgId, input.orgId),
          keyset(paymentPurchases.createdAt, paymentPurchases.id, input.cursor),
        ),
      )
      .orderBy(desc(paymentPurchases.createdAt), desc(paymentPurchases.id))
      .limit(input.limit + 1);
  }

  /** Whether the one-time launch grant has been posted, and when. */
  async readFreeGrant(orgId: string) {
    const [grant] = await this.db
      .select({
        createdAt: creditLedgerEntries.createdAt,
        quantity: creditLedgerEntries.quantity,
      })
      .from(creditLedgerEntries)
      .where(
        and(
          eq(creditLedgerEntries.orgId, orgId),
          eq(creditLedgerEntries.type, 'free_grant'),
        ),
      )
      .limit(1);
    return grant;
  }
}

/**
 * `(created_at, id) < (cursor)`.
 *
 * The id tiebreak is not decoration: several entries share a `created_at` when
 * they are written in one transaction, and without it a page boundary landing
 * inside such a group drops or repeats rows.
 */
function keyset(
  createdAt: PgColumn,
  id: PgColumn,
  cursor: HistoryCursor | null,
) {
  if (!cursor) return undefined;
  return or(
    lt(createdAt, cursor.createdAt),
    and(eq(createdAt, cursor.createdAt), lt(id, sql`${cursor.id}::uuid`)),
  );
}
