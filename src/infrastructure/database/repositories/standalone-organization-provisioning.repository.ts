import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { memberships, organizations } from '../schema';

export interface StandaloneOrganizationProvisioningResult {
  organization: typeof organizations.$inferSelect;
  created: boolean;
}

export function buildStandaloneOrganizationSlug(userId: string): string {
  return `standalone-${userId}`;
}

@Injectable()
export class StandaloneOrganizationProvisioningRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async provision(
    userId: string,
    name: string,
  ): Promise<StandaloneOrganizationProvisioningResult> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ organization: organizations })
        .from(memberships)
        .innerJoin(organizations, eq(memberships.orgId, organizations.id))
        .where(
          and(eq(memberships.userId, userId), eq(memberships.role, 'owner')),
        )
        .orderBy(asc(memberships.createdAt), asc(memberships.id))
        .limit(1);

      if (existing) {
        return {
          organization: existing.organization,
          created: false,
        };
      }

      const slug = buildStandaloneOrganizationSlug(userId);
      const [inserted] = await tx
        .insert(organizations)
        .values({ name, slug })
        .onConflictDoNothing({ target: organizations.slug })
        .returning();

      const organization =
        inserted ??
        (await tx
          .select()
          .from(organizations)
          .where(eq(organizations.slug, slug))
          .limit(1)
          .then((rows) => rows[0]));

      if (!organization) {
        throw new Error('Failed to provision standalone organization');
      }

      await tx
        .insert(memberships)
        .values({
          orgId: organization.id,
          userId,
          role: 'owner',
        })
        .onConflictDoUpdate({
          target: [memberships.orgId, memberships.userId],
          set: { role: 'owner' },
        });

      return {
        organization,
        created: Boolean(inserted),
      };
    });
  }
}
