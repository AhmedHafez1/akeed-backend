import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { toDisplayedCredits } from '../../shared/billing/merchant-credits';
import * as schema from '../../infrastructure/database';
import { DRIZZLE } from '../../infrastructure/database/database.provider';
import {
  creditAccounts,
  creditLedgerEntries,
  creditReservations,
  integrations,
  organizations,
  paymentProviderEvents,
  paymentPurchases,
  verificationMessageDispatches,
} from '../../infrastructure/database/schema';
import type { CheckoutPaidFilter } from './checkout-attempts.policy';
import type { PaymentMode } from '../../shared/ports/payments.port';
import { PREPAID_CREDIT_PLATFORMS } from '../../shared/billing/credit-eligibility';
import { balanceState } from './standalone-billing-operations.policy';
import type {
  AccountBillingSummary,
  AccountFilters,
} from './standalone-billing-operations.types';
import type { AccountRow } from './standalone-billing.types';

/** One organization's checkout history, as the attempts query returns it. */
export interface CheckoutAttemptQueryRow extends Record<string, unknown> {
  org_id: string;
  organization_name: string | null;
  attempts: number;
  first_attempt_at: string | Date;
  last_attempt_at: string | Date;
  paid_ever: boolean;
  reference: string;
  status: string;
  total_minor: number;
  currency: string;
  checkout_expires_at: string | Date | null;
  reconciliation_code: string | null;
  decline_code: string | null;
  owner_email: string | null;
  owner_name: string | null;
  platform_type: string | null;
  platform_store_url: string | null;
  merchant_whatsapp_phone: string | null;
}

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
   * Every organization with a checkout in this deployment's payment mode,
   * newest attempt first, merchants who never paid ahead of those who did. In
   * production that leaves out test-mode checkouts: staff trying the sandbox,
   * not merchants to follow up.
   *
   * Contact details come from the owner's sign-up (email and name) and the
   * credit-billed source (WhatsApp number). A page asks for one row more than
   * it shows so the caller can tell whether another page exists.
   */
  async listCheckoutAttempts(
    limit: number,
    offset: number,
    paid: CheckoutPaidFilter,
    mode: PaymentMode,
  ): Promise<CheckoutAttemptQueryRow[]> {
    const paidCondition =
      paid === 'unpaid'
        ? sql`WHERE NOT attempts.paid_ever`
        : paid === 'paid'
          ? sql`WHERE attempts.paid_ever`
          : sql``;
    const platforms = sql.join(
      PREPAID_CREDIT_PLATFORMS.map((platform) => sql`${platform}`),
      sql`, `,
    );
    const result = await this.db.execute<CheckoutAttemptQueryRow>(sql`
      WITH attempts AS (
        SELECT
          purchase.org_id,
          count(*)::int AS attempts,
          min(purchase.created_at) AS first_attempt_at,
          max(purchase.created_at) AS last_attempt_at,
          bool_or(purchase.status IN ('successful', 'refunded')) AS paid_ever
        FROM ${paymentPurchases} AS purchase
        WHERE purchase.mode = ${mode}
        GROUP BY purchase.org_id
      )
      SELECT
        attempts.org_id,
        organization.name AS organization_name,
        attempts.attempts,
        attempts.first_attempt_at,
        attempts.last_attempt_at,
        attempts.paid_ever,
        latest.reference,
        latest.status,
        latest.total_minor,
        latest.currency,
        latest.checkout_expires_at,
        latest.reconciliation_code,
        decline.error_code AS decline_code,
        owner_user.email AS owner_email,
        owner_user.full_name AS owner_name,
        source.platform_type,
        source.platform_store_url,
        source.merchant_whatsapp_phone
      FROM attempts
      INNER JOIN ${organizations} AS organization
        ON organization.id = attempts.org_id
      CROSS JOIN LATERAL (
        SELECT
          purchase.id,
          purchase.reference,
          purchase.status::text AS status,
          purchase.total_minor,
          purchase.currency,
          purchase.checkout_expires_at,
          purchase.reconciliation_code
        FROM ${paymentPurchases} AS purchase
        WHERE purchase.org_id = attempts.org_id AND purchase.mode = ${mode}
        ORDER BY purchase.created_at DESC, purchase.id DESC
        LIMIT 1
      ) AS latest
      LEFT JOIN LATERAL (
        SELECT event.error_code
        FROM ${paymentProviderEvents} AS event
        WHERE event.purchase_id = latest.id
          AND event.verified
          AND event.error_code IS NOT NULL
        ORDER BY event.received_at DESC
        LIMIT 1
      ) AS decline ON true
      LEFT JOIN LATERAL (
        SELECT
          member_user.email,
          member_user.raw_user_meta_data ->> 'full_name' AS full_name
        FROM memberships AS membership
        INNER JOIN auth.users AS member_user
          ON member_user.id = membership.user_id
        WHERE membership.org_id = attempts.org_id
          AND membership.role = 'owner'
        ORDER BY membership.created_at ASC
        LIMIT 1
      ) AS owner_user ON true
      LEFT JOIN LATERAL (
        SELECT
          integration.platform_type::text AS platform_type,
          integration.platform_store_url,
          integration.merchant_whatsapp_phone
        FROM ${integrations} AS integration
        WHERE integration.org_id = attempts.org_id
          AND integration.platform_type::text IN (${platforms})
        ORDER BY integration.is_active DESC NULLS LAST,
          integration.created_at DESC
        LIMIT 1
      ) AS source ON true
      ${paidCondition}
      ORDER BY attempts.paid_ever ASC, attempts.last_attempt_at DESC,
        attempts.org_id ASC
      LIMIT ${limit + 1}
      OFFSET ${offset}
    `);
    return [...result];
  }

  /**
   * The rows the staff list renders: organization, its credit-billed source, the
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
              inArray(integrations.platformType, [...PREPAID_CREDIT_PLATFORMS]),
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
              displayedAvailableCredits: toDisplayedCredits(
                Math.max(account.postedBalance - account.heldCredits, 0),
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
