import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { memberships } from '../schema';

@Injectable()
export class MembershipsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async createOrUpdateMembership(
    orgId: string,
    userId: string,
    role: 'owner' | 'admin' | 'viewer' = 'owner',
  ) {
    const [result] = await this.db
      .insert(memberships)
      .values({
        orgId,
        userId,
        role,
      })
      .onConflictDoUpdate({
        target: [memberships.orgId, memberships.userId],
        set: { role, createdAt: new Date().toISOString() },
      })
      .returning();
    return result;
  }

  async findByOrgAndUser(orgId: string, userId: string) {
    const [result] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .limit(1);
    return result;
  }

  async findByOrg(orgId: string) {
    return await this.db
      .select()
      .from(memberships)
      .where(eq(memberships.orgId, orgId));
  }

  async findByUser(userId: string) {
    return await this.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId));
  }
}
