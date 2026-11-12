import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../schema';
import { eq, and, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import {
  adminAccessAudit,
  adminStoreLifecycles,
  integrations,
} from '../schema';
import { encryptToken } from '../../../shared/utils/token-encryption.util';
import { resolvePaidThroughAtUninstall } from '../../../shared/billing/paid-through.policy';
import {
  effectiveBillingStatus,
  isPaidThroughLive,
  PAID_THROUGH_BILLING_STATUS,
} from '../../../shared/utils/billing.util';

@Injectable()
export class IntegrationsRepository {
  /** Staff-only lookup; merchant entrypoints use authenticated org-scoped reads. */
  async findById(id: string) {
    return this.db.query.integrations.findFirst({
      where: eq(integrations.id, id),
    });
  }
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

  /** Installed Shopify stores billed through a Shopify app subscription. */
  async findActiveShopifySubscriptions() {
    return await this.db.query.integrations.findMany({
      where: and(
        eq(integrations.platformType, 'shopify'),
        eq(integrations.isActive, true),
        isNotNull(integrations.shopifySubscriptionId),
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
          // A reinstall inside the 48-hour window keeps the store's history:
          // clearing the uninstall time cancels its scheduled deletion.
          uninstalledAt: null,
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

  /**
   * Staff remove a store's paid-through date (e.g. the old charge was
   * refunded by hand). A store using it right now loses the plan and reads as
   * cancelled, exactly as when the date passes. Audited like other staff
   * changes.
   */
  async clearPaidThrough(
    integrationId: string,
    audit: { userId: string; requestId?: string },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          orgId: integrations.orgId,
          billingStatus: integrations.billingStatus,
          paidThroughAt: integrations.paidThroughAt,
        })
        .from(integrations)
        .where(eq(integrations.id, integrationId))
        .for('update');
      if (!current) return false;
      const now = new Date().toISOString();
      const inPaidThrough =
        current.billingStatus?.trim().toLowerCase() ===
        PAID_THROUGH_BILLING_STATUS;
      await tx
        .update(integrations)
        .set({
          paidThroughAt: null,
          ...(inPaidThrough
            ? {
                billingStatus: 'cancelled',
                billingStatusUpdatedAt: now,
                billingCanceledAt: now,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(integrations.id, integrationId));
      await tx.insert(adminAccessAudit).values({
        userId: audit.userId,
        action: 'store.paid-through.clear',
        outcome: 'allowed',
        requestId: audit.requestId,
        targetIntegrationId: integrationId,
        metadata: {
          orgId: current.orgId,
          previousPaidThroughAt: current.paidThroughAt,
          previousBillingStatus: current.billingStatus,
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
      // Read under a lock first: the paid-through rule needs the billing
      // state as it was just before this uninstall, and a concurrent
      // subscription webhook must not change it in between.
      const [current] = await tx
        .select({
          billingPlanId: integrations.billingPlanId,
          billingStatus: integrations.billingStatus,
          billingActivatedAt: integrations.billingActivatedAt,
          billingCanceledAt: integrations.billingCanceledAt,
          shopifySubscriptionId: integrations.shopifySubscriptionId,
          paidThroughAt: integrations.paidThroughAt,
          uninstalledAt: integrations.uninstalledAt,
        })
        .from(integrations)
        .where(eq(integrations.id, integrationId))
        .for('update');
      const paidThroughAt = current
        ? resolvePaidThroughAtUninstall(current, occurredAt)
        : null;

      const [updated] = await tx
        .update(integrations)
        .set({
          ...(paidThroughAt ? { paidThroughAt } : {}),
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
          // Starts the 48-hour window; the store's data is kept until then.
          // A redelivered uninstall keeps the first time, so it can't
          // extend the window.
          uninstalledAt: sql`COALESCE(${integrations.uninstalledAt}, ${occurredAt})`,
          updatedAt: occurredAt,
        })
        .where(eq(integrations.id, integrationId))
        .returning();

      // The plan as it was at uninstall, for admin: a reinstall or a new plan
      // later overwrites the integration's billing columns.
      const paidThroughAtUninstall =
        paidThroughAt ??
        (current &&
        isPaidThroughLive(current.paidThroughAt, new Date(occurredAt))
          ? current.paidThroughAt
          : null);
      await tx
        .update(adminStoreLifecycles)
        .set({
          uninstalledAt: occurredAt,
          uninstallPlanId: current?.billingPlanId ?? null,
          uninstallBillingStatus: current
            ? effectiveBillingStatus(
                current.billingStatus,
                current.paidThroughAt,
                new Date(occurredAt),
              )
            : null,
          uninstallPaidThroughAt: paidThroughAtUninstall,
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

  /**
   * Shopify stores still uninstalled whose 48-hour window has closed, oldest
   * first. Rows uninstalled before `uninstalled_at` existed stay NULL and are
   * left to shop/redact.
   */
  async findUninstalledShopifyDueForDeletion(cutoff: string, limit = 100) {
    return this.db
      .select({
        id: integrations.id,
        orgId: integrations.orgId,
        platformStoreUrl: integrations.platformStoreUrl,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.platformType, 'shopify'),
          eq(integrations.isActive, false),
          isNotNull(integrations.uninstalledAt),
          lte(integrations.uninstalledAt, cutoff),
        ),
      )
      .orderBy(integrations.uninstalledAt)
      .limit(limit);
  }

  private encryptAccessToken(accessToken: string): string {
    const encryptionKey = this.configService.getOrThrow<string>(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    );
    return encryptToken(accessToken, encryptionKey);
  }
}
