import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../infrastructure/database';
import { DRIZZLE } from '../../infrastructure/database/database.provider';
import {
  adminAccessAudit,
  billingFreePlanClaims,
  creditAccounts,
  creditLedgerEntries,
  creditReservations,
  integrationMonthlyUsage,
  integrations,
  memberships,
  orders,
  organizations,
  paymentPurchases,
  verificationMessageDispatches,
} from '../../infrastructure/database/schema';
import { balanceState } from './standalone-billing-operations.policy';
import type {
  AccountBillingSummary,
  AccountFilters,
} from './standalone-billing-operations.types';
import { CreditAccountingRepository } from '../../infrastructure/database/repositories/credit-accounting.repository';
import {
  buildStandaloneSourceIdentity,
  provisionStandaloneSourceForOrganization,
} from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import { evaluateStandaloneApproval } from './standalone-billing.policy';
import type {
  ApprovalApplyResult,
  ApprovalEvaluation,
  ApprovalPreviewEntry,
  ApprovalSnapshot,
} from './standalone-billing.types';

type ApprovalDatabase = Pick<
  PostgresJsDatabase<typeof schema>,
  'select' | 'execute' | 'insert' | 'update'
>;
const PREVIEW_ACTION = 'standalone-billing.preview';
const APPROVE_ACTION = 'standalone-billing.approve';

export function buildFreeGrantKey(orgId: string): string {
  return `standalone-free-grant:${orgId}:v1`;
}

@Injectable()
export class StandaloneBillingRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly credits: CreditAccountingRepository,
  ) {}

  /**
   * Walks organizations by id. Credit filters are applied here, before the
   * page is cut, so a filtered page is only short when it is the last one.
   * The approval filter is still applied afterwards, because approval status
   * is computed from a whole snapshot rather than stored.
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
   * The billing state the list shows beside each approval row. The two
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

  async loadSnapshots(
    orgIds: string[],
    database: ApprovalDatabase = this.db,
  ): Promise<ApprovalSnapshot[]> {
    if (orgIds.length === 0) return [];
    const identities = orgIds.map(buildStandaloneSourceIdentity);
    const [
      organizationRows,
      memberRows,
      sourceRows,
      usageRows,
      claimRows,
      orderRows,
      accountRows,
      grantRows,
    ] = await Promise.all([
      database
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(inArray(organizations.id, orgIds)),
      database
        .select({
          id: memberships.id,
          orgId: memberships.orgId,
          userId: memberships.userId,
          role: memberships.role,
        })
        .from(memberships)
        .where(inArray(memberships.orgId, orgIds))
        .orderBy(asc(memberships.id)),
      database
        .select({
          id: integrations.id,
          orgId: integrations.orgId,
          platformType: integrations.platformType,
          identity: integrations.platformStoreUrl,
          isActive: integrations.isActive,
          billingPlanId: integrations.billingPlanId,
          billingStatus: integrations.billingStatus,
          billingActivatedAt: integrations.billingActivatedAt,
          billingStatusUpdatedAt: integrations.billingStatusUpdatedAt,
          pendingBillingPlanId: integrations.pendingBillingPlanId,
          billingInitiatedAt: integrations.billingInitiatedAt,
          billingCanceledAt: integrations.billingCanceledAt,
          updatedAt: integrations.updatedAt,
          hasSubscription: sql<boolean>`${integrations.shopifySubscriptionId} IS NOT NULL`,
          hasCredentials: sql<boolean>`${integrations.accessToken} IS NOT NULL OR ${integrations.webhookSecret} IS NOT NULL`,
        })
        .from(integrations)
        .where(
          or(
            inArray(integrations.orgId, orgIds),
            and(
              eq(integrations.platformType, 'standalone'),
              inArray(integrations.platformStoreUrl, identities),
            ),
          ),
        )
        .orderBy(asc(integrations.id)),
      database
        .select({
          id: integrationMonthlyUsage.id,
          orgId: integrationMonthlyUsage.orgId,
          integrationId: integrationMonthlyUsage.integrationId,
          periodStart: integrationMonthlyUsage.periodStart,
          consumedCount: integrationMonthlyUsage.consumedCount,
          blockedCount: integrationMonthlyUsage.blockedCount,
          includedLimit: integrationMonthlyUsage.includedLimit,
        })
        .from(integrationMonthlyUsage)
        .where(inArray(integrationMonthlyUsage.orgId, orgIds))
        .orderBy(asc(integrationMonthlyUsage.id)),
      database
        .select({
          id: billingFreePlanClaims.id,
          orgId: billingFreePlanClaims.orgId,
          platformType: billingFreePlanClaims.platformType,
        })
        .from(billingFreePlanClaims)
        .where(inArray(billingFreePlanClaims.orgId, orgIds))
        .orderBy(asc(billingFreePlanClaims.id)),
      database
        .select({ orgId: orders.orgId, count: sql<number>`count(*)::int` })
        .from(orders)
        .where(inArray(orders.orgId, orgIds))
        .groupBy(orders.orgId),
      database
        .select({
          orgId: creditAccounts.orgId,
          status: creditAccounts.status,
          postedBalance: creditAccounts.postedBalance,
          heldCredits: creditAccounts.heldCredits,
          version: creditAccounts.version,
          approvedAt: creditAccounts.approvedAt,
        })
        .from(creditAccounts)
        .where(inArray(creditAccounts.orgId, orgIds)),
      database
        .select({ orgId: creditLedgerEntries.orgId })
        .from(creditLedgerEntries)
        .where(
          and(
            inArray(creditLedgerEntries.orgId, orgIds),
            eq(creditLedgerEntries.type, 'free_grant'),
          ),
        ),
    ]);
    const ownerIds = [
      ...new Set(
        memberRows
          .filter((member) => member.role === 'owner')
          .map((member) => member.userId),
      ),
    ];
    const ownedRows =
      ownerIds.length === 0
        ? []
        : await database
            .select({ userId: memberships.userId, orgId: memberships.orgId })
            .from(memberships)
            .where(
              and(
                inArray(memberships.userId, ownerIds),
                eq(memberships.role, 'owner'),
              ),
            )
            .orderBy(asc(memberships.orgId), asc(memberships.userId));
    return orgIds.map((orgId) => {
      const members = memberRows.filter((member) => member.orgId === orgId);
      const owners = new Set(
        members
          .filter((member) => member.role === 'owner')
          .map((member) => member.userId),
      );
      const account = accountRows.find((row) => row.orgId === orgId);
      return {
        orgId,
        organization:
          organizationRows.find((organization) => organization.id === orgId) ??
          null,
        memberships: members.map(({ id, userId, role }) => ({
          id,
          userId,
          role,
        })),
        ownedOrganizations: ownedRows.filter((owned) =>
          owners.has(owned.userId),
        ),
        sources: sourceRows.filter((source) => source.orgId === orgId),
        identityConflict: sourceRows.some(
          (source) =>
            source.platformType === 'standalone' &&
            source.identity === buildStandaloneSourceIdentity(orgId) &&
            source.orgId !== orgId,
        ),
        claims: claimRows
          .filter((claim) => claim.orgId === orgId)
          .map(({ id, platformType }) => ({ id, platformType })),
        usage: usageRows
          .filter((usage) => usage.orgId === orgId)
          .map(
            ({
              id,
              integrationId,
              periodStart,
              consumedCount,
              blockedCount,
              includedLimit,
            }) => ({
              id,
              integrationId,
              periodStart,
              consumedCount,
              blockedCount,
              includedLimit,
            }),
          ),
        orderCount:
          orderRows.find((order) => order.orgId === orgId)?.count ?? 0,
        account: account
          ? {
              status: account.status,
              postedBalance: account.postedBalance,
              heldCredits: account.heldCredits,
              version: account.version,
              approvedAt: account.approvedAt,
            }
          : null,
        freeGrantPresent: grantRows.some((grant) => grant.orgId === orgId),
      };
    });
  }

  async savePreview(userId: string, evaluations: ApprovalEvaluation[]) {
    const [audit] = await this.db
      .insert(adminAccessAudit)
      .values({
        userId,
        action: PREVIEW_ACTION,
        outcome: 'allowed',
        metadata: {
          version: 1,
          entries: evaluations.map(({ row, fingerprint }) => ({
            orgId: row.orgId,
            fingerprint,
          })),
          rows: evaluations.map(({ row }) => row),
        },
      })
      .returning({ id: adminAccessAudit.id });
    return audit.id;
  }

  async readPreview(
    previewId: string,
    userId: string,
  ): Promise<ApprovalPreviewEntry[]> {
    const [preview] = await this.db
      .select({ metadata: adminAccessAudit.metadata })
      .from(adminAccessAudit)
      .where(
        and(
          eq(adminAccessAudit.id, previewId),
          eq(adminAccessAudit.userId, userId),
          eq(adminAccessAudit.action, PREVIEW_ACTION),
        ),
      );
    const metadata = preview?.metadata as
      | { version?: unknown; entries?: unknown }
      | undefined;
    const entries = metadata?.entries;
    if (
      metadata?.version !== 1 ||
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.length > 50 ||
      !entries.every(isPreviewEntry)
    ) {
      throw new NotFoundException('Approval preview not found');
    }
    return entries;
  }

  /**
   * Approves one organization. The lock order — owner advisory locks, then
   * organization, memberships, sources and finally the credit account — is the
   * order every later credit mutation has to take. The owner advisory key is
   * the one merchant signup provisioning already holds, so staff approval and
   * self-serve provisioning cannot interleave.
   */
  async approveOrganization(
    entry: ApprovalPreviewEntry,
    userId: string,
    previewId: string,
    reason: string,
    freeGrantQuantity: number,
  ): Promise<ApprovalApplyResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(
          async (tx) => {
            const ownerRows = await tx
              .select({ userId: memberships.userId })
              .from(memberships)
              .where(
                and(
                  eq(memberships.orgId, entry.orgId),
                  eq(memberships.role, 'owner'),
                ),
              )
              .orderBy(asc(memberships.userId));
            for (const owner of ownerRows)
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner.userId}, 0))`,
              );
            await tx
              .select({ id: organizations.id })
              .from(organizations)
              .where(eq(organizations.id, entry.orgId))
              .for('update');
            await tx
              .select({ id: memberships.id })
              .from(memberships)
              .where(eq(memberships.orgId, entry.orgId))
              .for('update');
            await tx
              .select({ id: integrations.id })
              .from(integrations)
              .where(eq(integrations.orgId, entry.orgId))
              .for('update');
            const [prior] = await tx
              .select({
                id: adminAccessAudit.id,
                integrationId: adminAccessAudit.targetIntegrationId,
              })
              .from(adminAccessAudit)
              .where(
                and(
                  eq(adminAccessAudit.action, APPROVE_ACTION),
                  eq(adminAccessAudit.userId, userId),
                  sql`${adminAccessAudit.metadata}->>'previewId' = ${previewId}`,
                  sql`${adminAccessAudit.metadata}->>'orgId' = ${entry.orgId}`,
                ),
              )
              .limit(1);
            if (prior)
              return {
                orgId: entry.orgId,
                outcome: 'already_applied',
                reason: 'already_approved',
                auditId: prior.id,
                integrationId: prior.integrationId ?? undefined,
              };
            await this.credits.ensurePendingAccount(tx, entry.orgId);
            const account = await this.credits.lockAccount(tx, entry.orgId);
            const [snapshot] = await this.loadSnapshots([entry.orgId], tx);
            const evaluated = evaluateStandaloneApproval(
              snapshot,
              freeGrantQuantity,
            );
            if (evaluated.fingerprint !== entry.fingerprint)
              return {
                orgId: entry.orgId,
                outcome: 'changed',
                reason: 'preview_changed',
              };
            if (evaluated.row.status !== 'eligible')
              return {
                orgId: entry.orgId,
                outcome:
                  evaluated.row.status === 'already_approved'
                    ? 'unchanged'
                    : 'skipped',
                reason: evaluated.row.reason,
              };
            const existingSource = snapshot.sources[0];
            const sourceResult = existingSource
              ? { integration: existingSource, sourceCreated: false }
              : await provisionStandaloneSourceForOrganization(
                  tx,
                  entry.orgId,
                  { grantEntitlement: false },
                );
            const integrationId = sourceResult.integration.id;
            const now = new Date().toISOString();
            const after = {
              billingPlanId: existingSource?.billingPlanId ?? null,
              billingStatus: existingSource?.billingStatus ?? null,
              billingActivatedAt: existingSource?.billingActivatedAt ?? null,
              billingStatusUpdatedAt:
                existingSource?.billingStatusUpdatedAt ?? null,
            };
            const postedBalance = account.postedBalance + freeGrantQuantity;
            await this.credits.insertLedgerEntry(tx, {
              orgId: entry.orgId,
              type: 'free_grant',
              quantity: freeGrantQuantity,
              idempotencyKey: buildFreeGrantKey(entry.orgId),
              actorId: userId,
              reason,
              postedBalanceBefore: account.postedBalance,
              postedBalanceAfter: postedBalance,
            });
            const approved = await this.credits.updateProjection(tx, {
              orgId: entry.orgId,
              expectedVersion: account.version,
              postedBalance,
              heldCredits: account.heldCredits,
              status: 'active',
              approval: { approvedBy: userId, approvedAt: now, reason },
            });
            const invariant = await this.credits.checkInvariant(
              entry.orgId,
              tx,
            );
            if (!invariant?.consistent)
              throw new Error(
                `Credit projection mismatch after approving ${entry.orgId}`,
              );
            const [audit] = await tx
              .insert(adminAccessAudit)
              .values({
                userId,
                action: APPROVE_ACTION,
                outcome: 'allowed',
                targetIntegrationId: integrationId,
                metadata: {
                  version: 1,
                  previewId,
                  orgId: entry.orgId,
                  reason,
                  approvedAt: now,
                  sourceCreated: sourceResult.sourceCreated,
                  grantedCredits: freeGrantQuantity,
                  before: {
                    account: {
                      status: account.status,
                      postedBalance: account.postedBalance,
                      heldCredits: account.heldCredits,
                      version: account.version,
                    },
                    source: existingSource
                      ? {
                          billingPlanId: existingSource.billingPlanId,
                          billingStatus: existingSource.billingStatus,
                          billingActivatedAt: existingSource.billingActivatedAt,
                          billingStatusUpdatedAt:
                            existingSource.billingStatusUpdatedAt,
                          updatedAt: existingSource.updatedAt,
                        }
                      : null,
                  },
                  after: {
                    account: {
                      status: approved.status,
                      postedBalance: approved.postedBalance,
                      heldCredits: approved.heldCredits,
                      version: approved.version,
                    },
                    source: { ...after, updatedAt: now },
                  },
                },
              })
              .returning({ id: adminAccessAudit.id });
            return {
              orgId: entry.orgId,
              outcome: 'approved',
              reason: evaluated.row.reason,
              integrationId,
              auditId: audit.id,
              grantedCredits: freeGrantQuantity,
            };
          },
          { isolationLevel: 'serializable' },
        );
      } catch (error) {
        if (
          attempt >= 2 ||
          !['40001', '40P01'].includes(databaseErrorCode(error) ?? '')
        )
          throw error;
      }
    }
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
  // A pending account holds nothing yet, so it is never "zero" or "low".
  if (filters.balance === 'debt')
    conditions.push(
      onAccount(
        sql`account.status <> 'pending_approval' AND account.posted_balance < 0`,
      ),
    );
  if (filters.balance === 'zero')
    conditions.push(
      onAccount(
        sql`account.status <> 'pending_approval' AND account.posted_balance >= 0 AND account.posted_balance - account.held_credits <= 0`,
      ),
    );
  if (filters.balance === 'low')
    conditions.push(
      onAccount(
        sql`account.status <> 'pending_approval' AND account.posted_balance >= 0 AND account.posted_balance - account.held_credits BETWEEN 1 AND ${lowBalanceThreshold}`,
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

function isPreviewEntry(value: unknown): value is ApprovalPreviewEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.orgId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(entry.orgId) &&
    typeof entry.fingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(entry.fingerprint)
  );
}

export function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  return typeof candidate.code === 'string'
    ? candidate.code
    : databaseErrorCode(candidate.cause);
}
