import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { adminAccessAudit } from '../schema';

@Injectable()
export class AdminAccessAuditRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async record(params: {
    userId?: string;
    action: string;
    outcome: 'allowed' | 'denied';
    requestId?: string;
    targetIntegrationId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(adminAccessAudit).values({
      userId: params.userId,
      action: params.action,
      outcome: params.outcome,
      requestId: params.requestId,
      targetIntegrationId: params.targetIntegrationId,
      metadata: params.metadata ?? {},
    });
  }

  /** When a staff member last had an action allowed, or null if never. */
  async latestAllowedAt(
    userId: string,
    action: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ createdAt: adminAccessAudit.createdAt })
      .from(adminAccessAudit)
      .where(this.allowed(userId, action))
      .orderBy(desc(adminAccessAudit.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  }

  /** How many times a staff member had an action allowed since a time. */
  async countAllowedSince(
    userId: string,
    action: string,
    since: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(adminAccessAudit)
      .where(
        and(
          this.allowed(userId, action),
          gte(adminAccessAudit.createdAt, since),
        ),
      );
    return Number(row?.total ?? 0);
  }

  private allowed(userId: string, action: string) {
    return and(
      eq(adminAccessAudit.userId, userId),
      eq(adminAccessAudit.action, action),
      eq(adminAccessAudit.outcome, 'allowed'),
    );
  }
}
