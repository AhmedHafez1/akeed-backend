import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { organizations } from '../schema';

@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async createOrUpdateBySlug(
    name: string,
    slug: string,
  ): Promise<typeof organizations.$inferSelect> {
    const [result] = await this.db
      .insert(organizations)
      .values({
        name,
        slug,
      })
      .onConflictDoUpdate({
        target: organizations.slug,
        set: { name, updatedAt: new Date().toISOString() },
      })
      .returning();
    return result;
  }

  async updateById(
    id: string,
    updates: Partial<typeof organizations.$inferInsert>,
  ): Promise<typeof organizations.$inferSelect | undefined> {
    const [result] = await this.db
      .update(organizations)
      .set({
        ...updates,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organizations.id, id))
      .returning();
    return result;
  }

  async findById(
    id: string,
  ): Promise<typeof organizations.$inferSelect | undefined> {
    const org = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1)
      .then((res) => res[0]);
    return org;
  }
}
