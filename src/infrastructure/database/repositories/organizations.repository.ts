import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { organizations } from '../schema';

@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async createOrUpdateBySlug(name: string, slug: string) {
    const [result] = await this.db
      .insert(organizations)
      .values({
        name,
        slug,
      })
      .onConflictDoUpdate({
        target: organizations.slug,
        set: { updatedAt: new Date().toISOString() },
      })
      .returning();
    return result;
  }

  async findById(id: string) {
    const org = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1)
      .then((res) => res[0]);
    return org;
  }
}
