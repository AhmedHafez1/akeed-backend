import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import { integrations } from '../schema';

@Injectable()
export class IntegrationsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async findByPlatformDomain(domain: string, platformType: string) {
    return await this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.platformStoreUrl, domain),
        eq(integrations.platformType, platformType),
      ),
    });
  }

  async findByDomain(domain: string) {
    return this.findByPlatformDomain(domain, 'shopify');
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

    if (existing) {
      const [updated] = await this.db
        .update(integrations)
        .set({
          orgId,
          platformType: patformType,
          platformStoreUrl: shopDomain,
          accessToken,
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
        accessToken,
        expiresAt,
        isActive: true,
      })
      .returning();

    return created;
  }
}
