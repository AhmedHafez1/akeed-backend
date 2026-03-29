import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql, eq } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { webhookEvents } from '../schema';

interface WebhookEventInsert {
  platform: string;
  jobType: string;
  idempotencyKey: string;
  storeDomain: string;
  orgId?: string | null;
  integrationId?: string | null;
  rawPayload: Record<string, unknown>;
}

export interface WebhookEvent {
  id: string;
  platform: string;
  jobType: string;
  idempotencyKey: string;
  storeDomain: string;
  orgId: string | null;
  integrationId: string | null;
  status: string;
  rawPayload: unknown;
  attempts: number;
  lastError: string | null;
  processedAt: string | null;
  receivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

@Injectable()
export class WebhookEventsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Insert a new webhook event if no duplicate exists for the
   * (platform, idempotencyKey) pair.
   *
   * @returns The inserted row, or `null` if a duplicate was detected.
   */
  async insertIfNew(event: WebhookEventInsert): Promise<WebhookEvent | null> {
    const rows = (await this.db
      .insert(webhookEvents)
      .values({
        platform: event.platform,
        jobType: event.jobType,
        idempotencyKey: event.idempotencyKey,
        storeDomain: event.storeDomain,
        orgId: event.orgId ?? null,
        integrationId: event.integrationId ?? null,
        rawPayload: event.rawPayload,
        status: 'pending',
      })
      .onConflictDoNothing({
        target: [webhookEvents.platform, webhookEvents.idempotencyKey],
      })
      .returning()) as WebhookEvent[];

    return rows[0] ?? null;
  }

  async markProcessing(id: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ status: 'processing', updatedAt: new Date().toISOString() })
      .where(sql`${webhookEvents.id} = ${id}`);
  }

  async markCompleted(id: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: 'completed',
        processedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(sql`${webhookEvents.id} = ${id}`);
  }

  async markFailed(id: string, error: string, attempts: number): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: 'failed',
        lastError: error,
        attempts,
        updatedAt: new Date().toISOString(),
      })
      .where(sql`${webhookEvents.id} = ${id}`);
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: 'skipped',
        lastError: reason,
        processedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(sql`${webhookEvents.id} = ${id}`);
  }

  async findById(id: string): Promise<WebhookEvent | undefined> {
    const rows = (await this.db
      .select()
      .from(webhookEvents)
      .where(sql`${webhookEvents.id} = ${id}`)
      .limit(1)) as WebhookEvent[];

    return rows[0];
  }

  async existsByIdempotencyKey(
    platform: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const rows = (await this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        sql`${webhookEvents.platform} = ${platform} AND ${webhookEvents.idempotencyKey} = ${idempotencyKey}`,
      )
      .limit(1)) as { id: string }[];

    return rows.length > 0;
  }

  async deleteByOrgId(orgId: string): Promise<number> {
    const results = await this.db
      .delete(webhookEvents)
      .where(eq(webhookEvents.orgId, orgId))
      .returning({ id: webhookEvents.id });

    return results.length;
  }
}
