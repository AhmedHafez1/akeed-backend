import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import { adminStoreLifecycles, integrations } from '../schema';
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
