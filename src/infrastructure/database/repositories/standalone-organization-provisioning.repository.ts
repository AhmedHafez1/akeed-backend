import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import {
  STANDALONE_BILLING_STATUS,
  STANDALONE_DEFAULT_PLAN_ID,
} from '../../../shared/billing/billing-plan';
import { readStandaloneCreditBillingConfig } from '../../../shared/config/standalone-credit-billing.config';
import { integrations, memberships, organizations } from '../schema';
import { ensurePendingCreditAccount } from './credit-accounting.repository';

export interface StandaloneOrganizationProvisioningResult {
  organization: typeof organizations.$inferSelect;
  integration: typeof integrations.$inferSelect;
  created: boolean;
  sourceCreated: boolean;
}

export class StandaloneSourceConflictError extends Error {
  constructor(
    message = 'The authenticated user already owns a non-Standalone source',
  ) {
    super(message);
    this.name = 'StandaloneSourceConflictError';
  }
}

export function buildStandaloneOrganizationSlug(userId: string): string {
  return `standalone-${userId}`;
}

export function buildStandaloneSourceIdentity(orgId: string): string {
  return `standalone:${orgId}`;
}

export type StandaloneProvisioningTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]
>[0];

export interface StandaloneSourceProvisioningOptions {
  /**
   * Writes the Starter/`not_required` entitlement at provisioning time. Credit
   * billing moves that grant to staff approval, so it is off whenever
   * `STANDALONE_CREDIT_BILLING_ENABLED` is set.
   */
  grantEntitlement: boolean;
}

export async function provisionStandaloneSourceForOrganization(
  tx: StandaloneProvisioningTransaction,
  orgId: string,
  options: StandaloneSourceProvisioningOptions,
) {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for('update');
  if (!organization) throw new Error('Standalone organization was not found');
  await ensurePendingCreditAccount(tx, orgId);
  const sourceIdentity = buildStandaloneSourceIdentity(orgId);
  const now = new Date().toISOString();
  const entitlement = options.grantEntitlement
    ? {
        billingStatus: STANDALONE_BILLING_STATUS,
        billingPlanId: STANDALONE_DEFAULT_PLAN_ID,
        billingActivatedAt: now,
        billingStatusUpdatedAt: now,
      }
    : {
        billingStatus: null,
        billingPlanId: null,
        billingActivatedAt: null,
        billingStatusUpdatedAt: null,
      };
  const [insertedSource] = await tx
    .insert(integrations)
    .values({
      orgId,
      platformType: 'standalone',
      platformStoreUrl: sourceIdentity,
      accessToken: null,
      webhookSecret: null,
      isActive: true,
      isAutoVerifyEnabled: false,
      assumeCodWhenPaymentMissing: false,
      onboardingStatus: 'pending',
      // Standalone tenants have no external billing to settle, but
      // `resolveEntitlement` still requires all three columns before it will
      // grant a plan — unlike Shopify, it has no default-plan fallback. Leaving
      // them NULL gave every self-serve standalone source `includedLimit: 0`
      // and blocked its sends with `billing_not_active`.
      //
      // Under credit billing that grant is exactly what staff approval is for,
      // so the columns stay NULL here and the approval transaction writes them
      // together with the launch grant.
      ...entitlement,
    })
    .onConflictDoNothing({
      target: [integrations.platformType, integrations.platformStoreUrl],
    })
    .returning();
  const integration =
    insertedSource ??
    (
      await tx
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.platformType, 'standalone'),
            eq(integrations.platformStoreUrl, sourceIdentity),
          ),
        )
        .limit(1)
    )[0];
  if (!integration || integration.orgId !== orgId || !integration.isActive) {
    throw new StandaloneSourceConflictError(
      'Standalone source identity is unavailable',
    );
  }
  return { integration, sourceCreated: Boolean(insertedSource) };
}

@Injectable()
export class StandaloneOrganizationProvisioningRepository {
  constructor(
    @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
    private readonly config: ConfigService,
  ) {}

  async provision(
    userId: string,
    name: string,
  ): Promise<StandaloneOrganizationProvisioningResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
      );

      const ownedOrganizations = await tx
        .select({ organization: organizations })
        .from(memberships)
        .innerJoin(organizations, eq(memberships.orgId, organizations.id))
        .where(
          and(eq(memberships.userId, userId), eq(memberships.role, 'owner')),
        )
        .orderBy(asc(memberships.createdAt), asc(memberships.id));

      const ownedOrganizationIds = ownedOrganizations.map(
        ({ organization }) => organization.id,
      );
      const ownedSources =
        ownedOrganizationIds.length === 0
          ? []
          : await tx.query.integrations.findMany({
              where: (table, { inArray }) =>
                inArray(table.orgId, ownedOrganizationIds),
            });

      if (ownedSources.some((source) => source.platformType !== 'standalone')) {
        throw new StandaloneSourceConflictError();
      }

      const existingSource = ownedSources.find(
        (source) => source.platformType === 'standalone' && source.isActive,
      );
      if (existingSource) {
        const existingOrganization = ownedOrganizations.find(
          ({ organization }) => organization.id === existingSource.orgId,
        )?.organization;
        if (!existingOrganization) {
          throw new Error('Standalone source organization was not found');
        }
        return {
          organization: existingOrganization,
          integration: existingSource,
          created: false,
          sourceCreated: false,
        };
      }

      const slug = buildStandaloneOrganizationSlug(userId);
      const existingOrganization = ownedOrganizations[0]?.organization;
      const [inserted] = existingOrganization
        ? []
        : await tx
            .insert(organizations)
            .values({ name, slug })
            .onConflictDoNothing({ target: organizations.slug })
            .returning();

      const organization =
        existingOrganization ??
        inserted ??
        (await tx
          .select()
          .from(organizations)
          .where(eq(organizations.slug, slug))
          .limit(1)
          .then((rows) => rows[0]));

      if (!existingOrganization && !inserted && organization) {
        throw new StandaloneSourceConflictError(
          'The stable Standalone organization identity is already owned',
        );
      }

      if (!organization) {
        throw new Error('Failed to provision standalone organization');
      }

      await tx
        .insert(memberships)
        .values({
          orgId: organization.id,
          userId,
          role: 'owner',
        })
        .onConflictDoUpdate({
          target: [memberships.orgId, memberships.userId],
          set: { role: 'owner' },
        });

      const { integration, sourceCreated } =
        await provisionStandaloneSourceForOrganization(tx, organization.id, {
          grantEntitlement: !readStandaloneCreditBillingConfig(this.config)
            .enabled,
        });

      return {
        organization,
        integration,
        created: Boolean(inserted),
        sourceCreated,
      };
    });
  }
}
