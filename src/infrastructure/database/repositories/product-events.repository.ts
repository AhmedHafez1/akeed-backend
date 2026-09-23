import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { integrations, productEvents } from '../schema';
import type {
  ProductEventName,
  ProductEventProps,
} from '../../../shared/analytics/product-events';

export type ProductEventRecord = typeof productEvents.$inferSelect;

@Injectable()
export class ProductEventsRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: DrizzleDB,
  ) {}

  /**
   * Inserts one event, taking org_id from the integration row so callers that
   * only hold an integration id (webhooks, milestone writers) cannot pair it
   * with the wrong tenant.
   */
  async insert(params: {
    integrationId: string;
    name: ProductEventName;
    props?: ProductEventProps;
    occurredAt?: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ${productEvents} ("org_id", "integration_id", "name", "props", "created_at")
      SELECT ${integrations.orgId}, ${integrations.id}, ${params.name},
             ${JSON.stringify(params.props ?? {})}::jsonb,
             ${params.occurredAt ?? new Date().toISOString()}
      FROM ${integrations}
      WHERE ${integrations.id} = ${params.integrationId}
    `);
  }

  async countSince(params: {
    integrationId: string;
    names: readonly ProductEventName[];
    since: string;
  }): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(productEvents)
      .where(
        and(
          eq(productEvents.integrationId, params.integrationId),
          inArray(productEvents.name, [...params.names]),
          gte(productEvents.createdAt, params.since),
        ),
      );
    return row?.count ?? 0;
  }

  async findLatest(params: {
    integrationId: string;
    names: readonly ProductEventName[];
    since?: string;
  }): Promise<ProductEventRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(productEvents)
      .where(
        and(
          eq(productEvents.integrationId, params.integrationId),
          inArray(productEvents.name, [...params.names]),
          params.since ? gte(productEvents.createdAt, params.since) : undefined,
        ),
      )
      .orderBy(desc(productEvents.createdAt))
      .limit(1);
    return row;
  }
}
