import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { organizations } from '../schema';
import { encryptToken } from 'src/shared/utils/token-encryption.util';

@Injectable()
export class OrganizationsRepository {
  constructor(
    @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
    private readonly configService: ConfigService,
  ) {}

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
    const encryptedUpdates = { ...updates };

    if (
      encryptedUpdates.waAccessToken &&
      typeof encryptedUpdates.waAccessToken === 'string'
    ) {
      encryptedUpdates.waAccessToken = this.encryptAccessToken(
        encryptedUpdates.waAccessToken,
      );
    }

    const [result] = await this.db
      .update(organizations)
      .set({
        ...encryptedUpdates,
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

  async deleteById(id: string): Promise<number> {
    const results = await this.db
      .delete(organizations)
      .where(eq(organizations.id, id))
      .returning({ id: organizations.id });

    return results.length;
  }

  private encryptAccessToken(accessToken: string): string {
    const encryptionKey = this.configService.getOrThrow<string>(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY',
    );
    return encryptToken(accessToken, encryptionKey);
  }
}
