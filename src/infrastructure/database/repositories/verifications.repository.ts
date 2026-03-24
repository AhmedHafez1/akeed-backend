import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import { DRIZZLE } from '../database.provider';
import { verifications } from '../schema';

@Injectable()
export class VerificationsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async getStatusCountsByOrgAndPeriod(
    orgId: string,
    startAt: string,
    endAt: string,
  ): Promise<{
    total: number;
    confirmed: number;
    canceled: number;
    sent: number;
    delivered: number;
    read: number;
  }> {
    const rows = await this.db
      .select({
        status: verifications.status,
        count: sql<number>`count(*)::int`,
      })
      .from(verifications)
      .where(
        and(
          eq(verifications.orgId, orgId),
          gte(verifications.createdAt, startAt),
          lt(verifications.createdAt, endAt),
        ),
      )
      .groupBy(verifications.status);

    const counts = {
      total: 0,
      confirmed: 0,
      canceled: 0,
      sent: 0,
      delivered: 0,
      read: 0,
    };

    for (const row of rows) {
      const count = Number(row.count ?? 0);
      counts.total += count;

      if (row.status === 'confirmed') {
        counts.confirmed += count;
      } else if (row.status === 'canceled') {
        counts.canceled += count;
      } else if (row.status === 'sent') {
        counts.sent += count;
      } else if (row.status === 'delivered') {
        counts.delivered += count;
      } else if (row.status === 'read') {
        counts.read += count;
      }
    }

    return counts;
  }

  async create(data: typeof verifications.$inferInsert) {
    const [result] = await this.db
      .insert(verifications)
      .values(data)
      .returning();
    return result;
  }

  async findByOrderId(id: string) {
    return await this.db.query.verifications.findFirst({
      where: eq(verifications.orderId, id),
    });
  }

  async findById(verificationId: string) {
    return await this.db.query.verifications.findFirst({
      where: eq(verifications.id, verificationId),
    });
  }

  async findByOrg(
    orgId: string,
    statuses?: VerificationStatus[],
    period?: { startAt: string; endAt: string },
    opts?: { cursor?: { createdAt: string; id: string }; limit?: number },
  ): Promise<
    Array<
      typeof verifications.$inferSelect & {
        order: typeof schema.orders.$inferSelect | null;
      }
    >
  > {
    const limit = opts?.limit ?? 50;

    const conditions = [
      eq(verifications.orgId, orgId),
      period ? gte(verifications.createdAt, period.startAt) : undefined,
      period ? lt(verifications.createdAt, period.endAt) : undefined,
      statuses && statuses.length > 0
        ? inArray(verifications.status, statuses)
        : undefined,
    ].filter(Boolean);

    if (opts?.cursor) {
      conditions.push(
        or(
          lt(verifications.createdAt, opts.cursor.createdAt),
          and(
            sql`${verifications.createdAt} = ${opts.cursor.createdAt}`,
            lt(verifications.id, opts.cursor.id),
          ),
        ),
      );
    }

    return await this.db.query.verifications.findMany({
      where: and(...conditions),
      with: {
        order: true,
      },
      orderBy: (verifications, { desc }) => [
        desc(verifications.createdAt),
        desc(verifications.id),
      ],
      limit,
    });
  }

  async updateStatus(
    id: string,
    status: VerificationStatus,
    waMessageId?: string,
  ) {
    return await this.db
      .update(verifications)
      .set({
        status: status as typeof verifications.$inferSelect.status,
        waMessageId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(verifications.id, id))
      .returning();
  }

  async updateStatusByWamid(wamid: string, status: VerificationStatus) {
    return await this.db
      .update(verifications)
      .set({
        status: status as typeof verifications.$inferSelect.status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(verifications.waMessageId, wamid))
      .returning();
  }

  async clearMetadataByOrderIds(orderIds: string[]): Promise<number> {
    if (orderIds.length === 0) {
      return 0;
    }

    const results = await this.db
      .update(verifications)
      .set({
        metadata: {},
        updatedAt: new Date().toISOString(),
      })
      .where(inArray(verifications.orderId, orderIds))
      .returning({ id: verifications.id });

    return results.length;
  }

  async deleteByOrgId(orgId: string): Promise<number> {
    const results = await this.db
      .delete(verifications)
      .where(eq(verifications.orgId, orgId))
      .returning({ id: verifications.id });

    return results.length;
  }
}
