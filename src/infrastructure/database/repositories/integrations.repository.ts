import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import {
  adminAccessAudit,
  adminStoreLifecycles,
  integrations,
} from '../schema';
import { encryptToken } from '../../../shared/utils/token-encryption.util';

@Injectable()
export class IntegrationsRepository {
  constructor(
    @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
    @Inject(ConfigService)
    private readonly configService: ConfigService,
  ) {}

  async findActiveByOrg(orgId: string) {
    return await this.db.query.integrations.findMany({
      where: and(
        eq(integrations.orgId, orgId),
        eq(integrations.isActive, true),
      ),
    });
  }

  async findByOrg(orgId: string) {
    return await this.db.query.integrations.findMany({
      where: eq(integrations.orgId, orgId),
      orderBy: (integrations, { desc }) => [desc(integrations.createdAt)],
    });
  }

  async findBySourceIdentity(source: {
    id: string;
    orgId: string;
    platformType: string;
    platformStoreUrl: string;
  }) {
    return await this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.id, source.id),
        eq(integrations.orgId, source.orgId),
        eq(integrations.platformType, source.platformType),
        eq(integrations.platformStoreUrl, source.platformStoreUrl),
      ),
    });
  }

  async findByPlatformDomain(domain: string, platformType: string) {
    return await this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.platformStoreUrl, domain),
        eq(integrations.platformType, platformType),
      ),
    });
  }

  async findByOrgAndPlatformDomain(
    orgId: string,
    domain: string,
    platformType: string,
  ) {
    return await this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.orgId, orgId),
        eq(integrations.platformStoreUrl, domain),
        eq(integrations.platformType, platformType),
      ),
    });
  }

  async findActiveByOrgAndPlatform(orgId: string, platformType: string) {
    return await this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.orgId, orgId),
        eq(integrations.platformType, platformType),
        eq(integrations.isActive, true),
      ),
    });
  }

  async create(data: typeof integrations.$inferInsert) {
    const [result] = await this.db
      .insert(integrations)
      .values(data)
      .returning();
    return result;
  }

  async upsertShopifyIntegration(
    orgId: string,
    shopDomain: string,
    patformType: string,
    accessToken: string,
    expiresAt?: string,
  ) {
    const existing = await this.findByPlatformDomain(shopDomain, patformType);
    const encryptedAccessToken = this.encryptAccessToken(accessToken);

    if (existing) {
      const [updated] = await this.db
        .update(integrations)
        .set({
          orgId,
          platformType: patformType,
          platformStoreUrl: shopDomain,
          accessToken: encryptedAccessToken,
          expiresAt,
          isActive: true,
          // A reinstall (inactive -> active) must re-run plan selection: the
          // uninstall cancelled the Shopify subscription. Also covers rows
          // uninstalled before the uninstall webhook reset onboarding, or a
          // missed app/uninstalled delivery.
          ...(existing.isActive
            ? {}
            : { onboardingStatus: 'pending' as const }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(integrations.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(integrations)
      .values({
        orgId,
        platformType: patformType,
        platformStoreUrl: shopDomain,
        accessToken: encryptedAccessToken,
        expiresAt,
        isActive: true,
      })
      .returning();

    return created;
  }

  async deleteByOrgId(orgId: string) {
    const results = await this.db
      .delete(integrations)
      .where(eq(integrations.orgId, orgId))
      .returning({ id: integrations.id });

    return results.length;
  }

  async deleteById(id: string) {
    const results = await this.db
      .delete(integrations)
      .where(eq(integrations.id, id))
      .returning({ id: integrations.id });

    return results.length;
  }

  async updateById(
    id: string,
    updates: Partial<typeof integrations.$inferInsert>,
  ) {
    const nextUpdates = { ...updates };
    if (typeof nextUpdates.accessToken === 'string') {
      nextUpdates.accessToken = this.encryptAccessToken(
        nextUpdates.accessToken,
      );
    }

    const [result] = await this.db
      .update(integrations)
      .set({
        ...nextUpdates,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(integrations.id, id))
      .returning();

    return result;
  }

  /**
   * Saves (or, with null, clears) the store's logo and banner URLs and
   * returns the ones they replaced, read under a row lock so two saves never
   * both see the same previous files. Undefined: no such store in the org.
   */
  async replaceLogo(
    integrationId: string,
    orgId: string,
    next: { logoUrl: string; logoBannerUrl: string } | null,
  ): Promise<
    { logoUrl: string | null; logoBannerUrl: string | null } | undefined
  > {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          logoUrl: integrations.logoUrl,
          logoBannerUrl: integrations.logoBannerUrl,
        })
        .from(integrations)
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.orgId, orgId),
          ),
        )
        .for('update');
      if (!current) return undefined;
      const now = new Date().toISOString();
      await tx
        .update(integrations)
        .set({
          logoUrl: next?.logoUrl ?? null,
          logoBannerUrl: next?.logoBannerUrl ?? null,
          logoUpdatedAt: next ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.orgId, orgId),
          ),
        );
      return current;
    });
  }

  /**
   * Staff switch the logo header for one store (on by default). The change and its audit row
   * are written together. False: no such store.
   */
  async setLogoHeaderEnabled(
    integrationId: string,
    enabled: boolean,
    audit: { userId: string; requestId?: string },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          orgId: integrations.orgId,
          enabled: integrations.logoHeaderEnabled,
        })
        .from(integrations)
        .where(eq(integrations.id, integrationId))
        .for('update');
      if (!current) return false;
      await tx
        .update(integrations)
        .set({
          logoHeaderEnabled: enabled,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(integrations.id, integrationId));
      await tx.insert(adminAccessAudit).values({
        userId: audit.userId,
        action: 'store.logo-header.set',
        outcome: 'allowed',
        requestId: audit.requestId,
        targetIntegrationId: integrationId,
        metadata: {
          orgId: current.orgId,
          previous: current.enabled,
          enabled,
        },
      });
      return true;
    });
  }

  /** The logo columns of one store, for staff. */
  async findLogoState(integrationId: string) {
    const [row] = await this.db
      .select({
        logoUrl: integrations.logoUrl,
        logoBannerUrl: integrations.logoBannerUrl,
        logoUpdatedAt: integrations.logoUpdatedAt,
        logoHeaderEnabled: integrations.logoHeaderEnabled,
      })
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .limit(1);
    return row;
  }

  async markShopifyUninstalled(
    integrationId: string,
    occurredAt = new Date().toISOString(),
  ) {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(integrations)
        .set({
          isActive: false,
          accessToken: null,
          webhookSecret: null,
          expiresAt: null,
          billingStatus: 'cancelled',
          pendingBillingPlanId: null,
          // Shopify cancels app subscriptions on uninstall; the id is dead.
          shopifySubscriptionId: null,
          // Keep billingPlanId so onboarding can show the recovery banner.
          onboardingStatus: 'pending',
          billingCanceledAt: sql`COALESCE(${integrations.billingCanceledAt}, ${occurredAt})`,
          billingStatusUpdatedAt: occurredAt,
          updatedAt: occurredAt,
        })
        .where(eq(integrations.id, integrationId))
        .returning();

      await tx
        .update(adminStoreLifecycles)
        .set({
          uninstalledAt: occurredAt,
          updatedAt: occurredAt,
          provenance: sql`COALESCE(${adminStoreLifecycles.provenance}, '{}'::jsonb) || '{"uninstall":"captured_exact"}'::jsonb`,
        })
        .where(
          and(
            eq(adminStoreLifecycles.integrationId, integrationId),
            isNull(adminStoreLifecycles.uninstalledAt),
          ),
        );

      return updated;
    });
  }

  private encryptAccessToken(accessToken: string): string {
    const encryptionKey = this.configService.getOrThrow<string>(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    );
    return encryptToken(accessToken, encryptionKey);
  }
}
