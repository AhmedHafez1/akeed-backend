import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../infrastructure/database';
import { DRIZZLE } from '../../infrastructure/database/database.provider';
import {
  creditAccounts,
  creditLedgerEntries,
  creditReservations,
  integrations,
  organizations,
  paymentPurchases,
  verificationMessageDispatches,
} from '../../infrastructure/database/schema';
import { balanceState } from './standalone-billing-operations.policy';
import type {
  AccountBillingSummary,
  AccountFilters,
} from './standalone-billing-operations.types';
import type { AccountRow } from './standalone-billing.types';

@Injectable()
export class StandaloneBillingRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /**
   * Walks organizations by id. Credit filters are applied here, before the
   * page is cut, so a filtered page is only short when it is the last one.
   */
  async listOrganizationIds(
    limit: number,
    cursor?: string,
    filters: AccountFilters = {},
    lowBalanceThreshold = 10,
  ) {
    return this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          cursor ? gt(organizations.id, cursor) : undefined,
          ...accountFilterConditions(filters, lowBalanceThreshold),
        ),
      )
      .orderBy(asc(organizations.id))
      .limit(limit + 1);
  }

  /**
   * The billing state the list shows beside each account row. The two
   * invariant sums alias their tables and qualify the outer column, for the
   * reason `CreditAccountingRepository.checkInvariant` documents.
   */
  async loadBillingSummaries(
    orgIds: string[],
    lowBalanceThreshold: number,
  ): Promise<Map<string, AccountBillingSummary>> {
    if (orgIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        orgId: creditAccounts.orgId,
        status: creditAccounts.status,
        postedBalance: creditAccounts.postedBalance,
        heldCredits: creditAccounts.heldCredits,
        ledgerBalance: sql<string>`(SELECT COALESCE(sum(entry.quantity), 0)::text FROM ${creditLedgerEntries} AS entry WHERE entry.org_id = ${creditAccounts}.org_id)`,
        reservationHolds: sql<string>`(SELECT COALESCE(sum(reservation.quantity), 0)::text FROM ${creditReservations} AS reservation WHERE reservation.org_id = ${creditAccounts}.org_id AND reservation.status = 'held')`,
        flaggedPurchases: sql<number>`(SELECT count(*)::int FROM ${paymentPurchases} AS purchase WHERE purchase.org_id = ${creditAccounts}.org_id AND purchase.reconciliation_required)`,
        unresolvedHolds: sql<number>`(SELECT count(*)::int FROM ${creditReservations} AS reservation JOIN ${verificationMessageDispatches} AS dispatch ON dispatch.id = reservation.dispatch_id WHERE reservation.org_id = ${creditAccounts}.org_id AND reservation.status = 'held' AND dispatch.state = 'outcome_unknown')`,
      })
      .from(creditAccounts)
      .where(inArray(creditAccounts.orgId, orgIds));
    return new Map(
      rows.map((row) => {
        const projectionConsistent =
          BigInt(row.ledgerBalance) === BigInt(row.postedBalance) &&
          BigInt(row.reservationHolds) === BigInt(row.heldCredits);
        const flaggedPurchases = Number(row.flaggedPurchases);
        const unresolvedHolds = Number(row.unresolvedHolds);
        return [
          row.orgId,
          {
            debtCredits: Math.max(-row.postedBalance, 0),
            balanceState: balanceState(row, lowBalanceThreshold),
            projectionConsistent,
            flaggedPurchases,
            unresolvedHolds,
            reconciliationRequired:
              !projectionConsistent ||
              flaggedPurchases > 0 ||
              unresolvedHolds > 0,
          },
        ];
      }),
    );
  }

  /**
   * The rows the staff list renders: organization, its Standalone source, the
   * credit account and whether the launch grant is on the ledger.
   */
  async loadAccountRows(
    orgIds: string[],
    lowBalanceThreshold: number,
  ): Promise<AccountRow[]> {
    if (orgIds.length === 0) return [];
    const [organizationRows, sourceRows, accountRows, grantRows, summaries] =
      await Promise.all([
        this.db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, orgIds)),
        this.db
          .select({
            id: integrations.id,
            orgId: integrations.orgId,
            identity: integrations.platformStoreUrl,
            platformType: integrations.platformType,
            isActive: integrations.isActive,
            billingPlanId: integrations.billingPlanId,
            billingStatus: integrations.billingStatus,
            billingActivatedAt: integrations.billingActivatedAt,
          })
          .from(integrations)
          .where(
            and(
              inArray(integrations.orgId, orgIds),
              eq(integrations.platformType, 'standalone'),
            ),
          )
          .orderBy(asc(integrations.id)),
        this.db
          .select({
            orgId: creditAccounts.orgId,
            status: creditAccounts.status,
            postedBalance: creditAccounts.postedBalance,
            heldCredits: creditAccounts.heldCredits,
            version: creditAccounts.version,
          })
          .from(creditAccounts)
          .where(inArray(creditAccounts.orgId, orgIds)),
        this.db
          .select({ orgId: creditLedgerEntries.orgId })
          .from(creditLedgerEntries)
          .where(
            and(
              inArray(creditLedgerEntries.orgId, orgIds),
              eq(creditLedgerEntries.type, 'free_grant'),
            ),
          ),
        this.loadBillingSummaries(orgIds, lowBalanceThreshold),
      ]);
    return orgIds.map((orgId) => {
      const source = sourceRows.find((row) => row.orgId === orgId);
      const account = accountRows.find((row) => row.orgId === orgId);
      return {
        orgId,
        organizationName:
          organizationRows.find((row) => row.id === orgId)?.name ?? null,
        source: source
          ? {
              id: source.id,
              identity: source.identity,
              platformType: source.platformType,
              isActive: source.isActive,
              billingPlanId: source.billingPlanId,
              billingStatus: source.billingStatus,
              billingActivatedAt: source.billingActivatedAt,
            }
          : null,
        account: account
          ? {
              status: account.status,
              postedBalance: account.postedBalance,
              heldCredits: account.heldCredits,
              availableCredits: Math.max(
                account.postedBalance - account.heldCredits,
                0,
              ),
              version: account.version,
            }
          : null,
        freeGrantPresent: grantRows.some((grant) => grant.orgId === orgId),
        billing: summaries.get(orgId) ?? null,
      };
    });
  }
}

function accountFilterConditions(
  filters: AccountFilters,
  lowBalanceThreshold: number,
): SQL[] {
  const onAccount = (condition: SQL) =>
    sql`EXISTS (SELECT 1 FROM ${creditAccounts} AS account WHERE account.org_id = ${organizations}.id AND ${condition})`;
  const conditions: SQL[] = [];
  if (filters.accountStatus)
    conditions.push(onAccount(sql`account.status = ${filters.accountStatus}`));
  if (filters.balance === 'debt')
    conditions.push(onAccount(sql`account.posted_balance < 0`));
  if (filters.balance === 'zero')
    conditions.push(
      onAccount(
        sql`account.posted_balance >= 0 AND account.posted_balance - account.held_credits <= 0`,
      ),
    );
  if (filters.balance === 'low')
    conditions.push(
      onAccount(
        sql`account.posted_balance >= 0 AND account.posted_balance - account.held_credits BETWEEN 1 AND ${lowBalanceThreshold}`,
      ),
    );
  if (filters.reconciliation === 'required')
    conditions.push(
      onAccount(sql`(
        EXISTS (SELECT 1 FROM ${paymentPurchases} AS purchase WHERE purchase.org_id = account.org_id AND purchase.reconciliation_required)
        OR EXISTS (SELECT 1 FROM ${creditReservations} AS reservation JOIN ${verificationMessageDispatches} AS dispatch ON dispatch.id = reservation.dispatch_id WHERE reservation.org_id = account.org_id AND reservation.status = 'held' AND dispatch.state = 'outcome_unknown')
        OR account.posted_balance <> (SELECT COALESCE(sum(entry.quantity), 0) FROM ${creditLedgerEntries} AS entry WHERE entry.org_id = account.org_id)
        OR account.held_credits <> (SELECT COALESCE(sum(reservation.quantity), 0) FROM ${creditReservations} AS reservation WHERE reservation.org_id = account.org_id AND reservation.status = 'held')
      )`),
    );
  return conditions;
}
