import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';

/**
 * One free plan per store and per merchant WhatsApp number. `phoneHash` is the
 * keyed hash from `hashClaimPhone`, never the number.
 */
@Injectable()
export class BillingFreePlanClaimsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  /** True when the store, or (given) the number, has claimed before. */
  async hasClaim(params: {
    platformType: string;
    shopDomain: string;
    phoneHash?: string | null;
  }): Promise<boolean> {
    const normalizedShopDomain = this.normalizeShopDomain(params.shopDomain);
    const phoneMatch = params.phoneHash
      ? sql`OR phone_hash = ${params.phoneHash}`
      : sql``;

    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT id
      FROM billing_free_plan_claims
      WHERE (platform_type = ${params.platformType}
        AND shop_domain = ${normalizedShopDomain})
        ${phoneMatch}
      LIMIT 1
    `);

    return rows.length > 0;
  }

  /**
   * Inserts the claim unless the store or the number already has one. The
   * conflict has no target on purpose: either unique key refuses the claim,
   * and a single insert keeps two simultaneous claims from both succeeding.
   */
  async createIfNew(params: {
    orgId: string;
    platformType: string;
    shopDomain: string;
    phoneHash: string;
  }): Promise<boolean> {
    const normalizedShopDomain = this.normalizeShopDomain(params.shopDomain);

    const rows = await this.db.execute<{ id: string }>(sql`
      INSERT INTO billing_free_plan_claims (org_id, platform_type, shop_domain, phone_hash)
      VALUES (${params.orgId}, ${params.platformType}, ${normalizedShopDomain}, ${params.phoneHash})
      ON CONFLICT DO NOTHING
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
