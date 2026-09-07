import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../infrastructure/database';
import { DRIZZLE } from '../../infrastructure/database/database.provider';
import {
  adminAccessAudit,
  billingFreePlanClaims,
  integrationMonthlyUsage,
  integrations,
  memberships,
  orders,
  organizations,
} from '../../infrastructure/database/schema';
import {
  buildStandaloneSourceIdentity,
  provisionStandaloneSourceForOrganization,
} from '../../infrastructure/database/repositories/standalone-organization-provisioning.repository';
import {
  STANDALONE_BILLING_STATUS,
  STANDALONE_DEFAULT_PLAN_ID,
} from '../../shared/billing/billing-plan';
import { evaluateStandalonePilot } from './standalone-pilot.policy';
import type {
  PilotApplyResult,
  PilotEvaluation,
  PilotPreviewEntry,
  PilotSnapshot,
} from './standalone-pilot.types';

type PilotDatabase = Pick<
  PostgresJsDatabase<typeof schema>,
  'select' | 'execute' | 'insert' | 'update'
>;
const PREVIEW_ACTION = 'standalone-pilot.preview';
const ACTIVATE_ACTION = 'standalone-pilot.activate';

@Injectable()
export class StandalonePilotRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async listOrganizationIds(limit: number, cursor?: string) {
    return this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(cursor ? gt(organizations.id, cursor) : undefined)
      .orderBy(asc(organizations.id))
      .limit(limit + 1);
  }

  async loadSnapshots(
    orgIds: string[],
    database: PilotDatabase = this.db,
  ): Promise<PilotSnapshot[]> {
    if (orgIds.length === 0) return [];
    const identities = orgIds.map(buildStandaloneSourceIdentity);
    const [
      organizationRows,
      memberRows,
      sourceRows,
      usageRows,
      claimRows,
      orderRows,
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
      };
    });
  }

  async savePreview(userId: string, evaluations: PilotEvaluation[]) {
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
  ): Promise<PilotPreviewEntry[]> {
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
      throw new NotFoundException('Pilot preview not found');
    }
    return entries;
  }

  async applyOrganization(
    entry: PilotPreviewEntry,
    userId: string,
    previewId: string,
    reason: string,
  ): Promise<PilotApplyResult> {
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
                  eq(adminAccessAudit.action, ACTIVATE_ACTION),
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
                reason: 'already_applied',
                auditId: prior.id,
                integrationId: prior.integrationId ?? undefined,
              };
            const [snapshot] = await this.loadSnapshots([entry.orgId], tx);
            const evaluated = evaluateStandalonePilot(snapshot);
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
                  evaluated.row.status === 'already_entitled'
                    ? 'unchanged'
                    : 'skipped',
                reason: evaluated.row.reason,
              };
            const existingSource = snapshot.sources[0];
            const sourceResult = existingSource
              ? { integration: existingSource, sourceCreated: false }
              : await provisionStandaloneSourceForOrganization(tx, entry.orgId);
            const integrationId = sourceResult.integration.id;
            const now = new Date().toISOString();
            const after = {
              billingPlanId: STANDALONE_DEFAULT_PLAN_ID,
              billingStatus: STANDALONE_BILLING_STATUS,
              billingActivatedAt: existingSource?.billingActivatedAt ?? now,
              billingStatusUpdatedAt: now,
            };
            await tx
              .update(integrations)
              .set({ ...after, updatedAt: now })
              .where(
                and(
                  eq(integrations.id, integrationId),
                  eq(integrations.orgId, entry.orgId),
                ),
              );
            const [audit] = await tx
              .insert(adminAccessAudit)
              .values({
                userId,
                action: ACTIVATE_ACTION,
                outcome: 'allowed',
                targetIntegrationId: integrationId,
                metadata: {
                  version: 1,
                  previewId,
                  orgId: entry.orgId,
                  reason,
                  activatedAt: now,
                  sourceCreated: sourceResult.sourceCreated,
                  before: existingSource
                    ? {
                        billingPlanId: existingSource.billingPlanId,
                        billingStatus: existingSource.billingStatus,
                        billingActivatedAt: existingSource.billingActivatedAt,
                        billingStatusUpdatedAt:
                          existingSource.billingStatusUpdatedAt,
                        updatedAt: existingSource.updatedAt,
                      }
                    : null,
                  after: { ...after, updatedAt: now },
                },
              })
              .returning({ id: adminAccessAudit.id });
            return {
              orgId: entry.orgId,
              outcome: 'activated',
              reason: evaluated.row.reason,
              integrationId,
              auditId: audit.id,
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

function isPreviewEntry(value: unknown): value is PilotPreviewEntry {
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
