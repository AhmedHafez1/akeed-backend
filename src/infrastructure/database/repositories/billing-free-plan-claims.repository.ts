import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';

@Injectable()
export class BillingFreePlanClaimsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async hasClaim(params: {
    platformType: string;
    shopDomain: string;
  }): Promise<boolean> {
    const normalizedShopDomain = this.normalizeShopDomain(params.shopDomain);

    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT id
      FROM billing_free_plan_claims
      WHERE platform_type = ${params.platformType}
        AND shop_domain = ${normalizedShopDomain}
      LIMIT 1
    `);

    return rows.length > 0;
  }

  async createIfNew(params: {
    orgId: string;
    platformType: string;
    shopDomain: string;
  }): Promise<boolean> {
    const normalizedShopDomain = this.normalizeShopDomain(params.shopDomain);

    const rows = await this.db.execute<{ id: string }>(sql`
      INSERT INTO billing_free_plan_claims (org_id, platform_type, shop_domain)
      VALUES (${params.orgId}, ${params.platformType}, ${normalizedShopDomain})
      ON CONFLICT (platform_type, shop_domain) DO NOTHING
      RETURNING id
    `);

    return rows.length > 0;
  }

  async deleteByPlatformAndShop(params: {
    platformType: string;
    shopDomain: string;
  }): Promise<number> {
    const normalizedShopDomain = this.normalizeShopDomain(params.shopDomain);

    const rows = await this.db.execute<{ id: string }>(sql`
      DELETE FROM billing_free_plan_claims
      WHERE platform_type = ${params.platformType}
        AND shop_domain = ${normalizedShopDomain}
      RETURNING id
    `);

    return rows.length;
  }

  private normalizeShopDomain(shopDomain: string): string {
    return shopDomain.trim().toLowerCase();
  }
}
