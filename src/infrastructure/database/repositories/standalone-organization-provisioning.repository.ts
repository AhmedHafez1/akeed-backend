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
import { ensureActiveCreditAccount } from './credit-accounting.repository';

export interface StandaloneOrganizationProvisioningResult {
  organization: typeof organizations.$inferSelect;
  integration: typeof integrations.$inferSelect;
  created: boolean;
  sourceCreated: boolean;
}

export interface SourcelessOrganizationProvisioningResult {
  organization: typeof organizations.$inferSelect;
  created: boolean;
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

/**
 * Onboarding v2 no longer asks Standalone merchants for confirmation rules
 * (docs/standalone-onboarding-v2.md), so a new source starts ready to send:
 * immediate first send, one follow-up after 2 h, escalation after 6 h. They are
 * written explicitly so a column default change cannot alter them. Only new
 * sources get them; existing rows keep what the merchant saved. Orders with no
 * payment method are treated as COD from the start, since COD is the core case.
 */
export const STANDALONE_SOURCE_DEFAULTS = {
  isAutoVerifyEnabled: true,
  sendDelayMinutes: 0,
  followUpEnabled: true,
  followUpDelayMinutes: 120,
  escalationEnabled: true,
  escalationDelayMinutes: 360,
  quietHoursEnabled: false,
  assumeCodWhenPaymentMissing: true,
} as const satisfies Partial<typeof integrations.$inferInsert>;

export type StandaloneProvisioningTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]
>[0];

export interface StandaloneSourceProvisioningOptions {
  /**
   * Writes the Starter/`not_required` entitlement at provisioning time. Credit
   * billing meters sends against the prepaid launch grant instead, so it is
   * off whenever `STANDALONE_CREDIT_BILLING_ENABLED` is set.
   */
  grantEntitlement: boolean;
  /** The owner whose verified signup activates the credit account. */
  actorId: string;
  /** Launch credits posted once when the credit account is opened. */
  freeGrant: number;
}

/**
 * The billing half of provisioning a credit-billed source, shared by Standalone
 * signup and the store platforms a merchant connects: opens the credit account
 * with its launch grant (once per organization) and returns the entitlement
 * columns the new source row takes.
 */
export async function provisionSourceBilling(
  tx: StandaloneProvisioningTransaction,
  orgId: string,
  options: StandaloneSourceProvisioningOptions,
  now = new Date().toISOString(),
) {
  await ensureActiveCreditAccount(tx, orgId, {
    actorId: options.actorId,
    freeGrant: options.freeGrant,
  });
  return options.grantEntitlement
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
}

/** What `provisionSourceBilling` needs, read from configuration. */
export function readSourceBillingOptions(
  config: ConfigService,
  actorId: string,
): StandaloneSourceProvisioningOptions {
  const creditBilling = readStandaloneCreditBillingConfig(config);
  return {
    grantEntitlement: !creditBilling.enabled,
    actorId,
    freeGrant: creditBilling.freeGrant,
  };
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
  const entitlement = await provisionSourceBilling(tx, orgId, options);
  const sourceIdentity = buildStandaloneSourceIdentity(orgId);
  const [insertedSource] = await tx
    .insert(integrations)
    .values({
      orgId,
      platformType: 'standalone',
      platformStoreUrl: sourceIdentity,
      accessToken: null,
      webhookSecret: null,
      isActive: true,
      ...STANDALONE_SOURCE_DEFAULTS,
      onboardingStatus: 'pending',
      // Standalone tenants have no external billing to settle, but
      // `resolveEntitlement` still requires all three columns before it will
      // grant a plan — unlike Shopify, it has no default-plan fallback. Leaving
      // them NULL gave every self-serve standalone source `includedLimit: 0`
      // and blocked its sends with `billing_not_active`.
      //
      // Under credit billing the prepaid launch grant replaces that plan, so
      // the columns stay NULL there.
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
        await provisionStandaloneSourceForOrganization(
          tx,
          organization.id,
          readSourceBillingOptions(this.config, userId),
        );

      return {
        organization,
        integration,
        created: Boolean(inserted),
        sourceCreated,
      };
    });
  }

  /**
   * The organization and its owner membership, with no source: for a merchant
   * who chose at signup to connect a store platform. That platform's install
   * provisions the source, so no Standalone source is created here and none
   * has to be converted later.
   *
   * A user who already owns an organization gets it back untouched, whatever
   * source it has.
   */
  async provisionWithoutSource(
    userId: string,
    name: string,
  ): Promise<SourcelessOrganizationProvisioningResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
      );

      const [owned] = await tx
        .select({ organization: organizations })
        .from(memberships)
        .innerJoin(organizations, eq(memberships.orgId, organizations.id))
        .where(
          and(eq(memberships.userId, userId), eq(memberships.role, 'owner')),
        )
        .orderBy(asc(memberships.createdAt), asc(memberships.id))
        .limit(1);
      if (owned) return { organization: owned.organization, created: false };

      const [organization] = await tx
        .insert(organizations)
        .values({ name, slug: buildStandaloneOrganizationSlug(userId) })
        .onConflictDoNothing({ target: organizations.slug })
        .returning();
      if (!organization) {
        throw new StandaloneSourceConflictError(
          'The stable Standalone organization identity is already owned',
        );
      }

      await tx
        .insert(memberships)
        .values({ orgId: organization.id, userId, role: 'owner' })
        .onConflictDoUpdate({
          target: [memberships.orgId, memberships.userId],
          set: { role: 'owner' },
        });

      return { organization, created: true };
    });
  }
}
