import { Inject, Injectable } from '@nestjs/common';
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
}
