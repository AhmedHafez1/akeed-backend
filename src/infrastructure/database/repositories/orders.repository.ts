import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import { orders } from '../schema';

@Injectable()
export class OrdersRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async create(data: typeof orders.$inferInsert) {
    const [result] = await this.db.insert(orders).values(data).returning();
    return result;
  }

  async findById(orderId: string) {
    return await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      with: {
        integration: true,
      },
    });
  }

  async findByExternalId(externalId: string, orgId: string) {
    return await this.db.query.orders.findFirst({
      where: and(
        eq(orders.externalOrderId, externalId),
        eq(orders.orgId, orgId),
      ),
    });
  }

  async findByOrg(orgId: string): Promise<
    Array<
      typeof orders.$inferSelect & {
        verifications: Array<typeof schema.verifications.$inferSelect>;
      }
    >
  > {
    return await this.db.query.orders.findMany({
      where: eq(orders.orgId, orgId),
      with: {
        verifications: true,
      },
      orderBy: (orders, { desc }) => [desc(orders.createdAt)],
    });
  }
}
