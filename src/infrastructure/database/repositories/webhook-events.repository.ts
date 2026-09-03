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
  dispatchRequired?: boolean;
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
  dispatchRequired: boolean;
  dispatchAttempts: number;
  lastDispatchError: string | null;
  nextDispatchAt: string | null;
  dispatchLeaseUntil: string | null;
  dispatchedAt: string | null;
  processingLeaseUntil: string | null;
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
   * (platform, storeDomain, idempotencyKey) source/event identity.
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
        dispatchRequired: event.dispatchRequired ?? false,
        nextDispatchAt: event.dispatchRequired
          ? new Date().toISOString()
          : null,
        status: 'pending',
      })
      .onConflictDoNothing({
        target: [
          webhookEvents.platform,
          webhookEvents.storeDomain,
          webhookEvents.idempotencyKey,
        ],
      })
      .returning()) as WebhookEvent[];

    return rows[0] ?? null;
  }

  async findBySourceAndIdempotency(
    platform: string,
    storeDomain: string,
    idempotencyKey: string,
  ): Promise<WebhookEvent | undefined> {
    const rows = (await this.db
      .select()
      .from(webhookEvents)
      .where(
        sql`${webhookEvents.platform} = ${platform} AND ${webhookEvents.storeDomain} = ${storeDomain} AND ${webhookEvents.idempotencyKey} = ${idempotencyKey}`,
      )
      .limit(1)) as WebhookEvent[];

    return rows[0];
  }

  async findRecoverable(
    limit: number,
    staleBefore: string,
    maxDispatchAttempts: number,
  ): Promise<WebhookEvent[]> {
    return (await this.db
      .select()
      .from(webhookEvents)
      .where(
        sql`${webhookEvents.dispatchRequired} = true
          AND ${webhookEvents.dispatchAttempts} < ${maxDispatchAttempts}
          AND (
            (${webhookEvents.status} = 'pending'
              AND ${webhookEvents.dispatchedAt} IS NULL
              AND (${webhookEvents.nextDispatchAt} IS NULL OR ${webhookEvents.nextDispatchAt} <= NOW())
              AND (${webhookEvents.dispatchLeaseUntil} IS NULL OR ${webhookEvents.dispatchLeaseUntil} <= NOW()))
            OR
            (${webhookEvents.status} = 'processing'
              AND ((${webhookEvents.processingLeaseUntil} IS NOT NULL AND ${webhookEvents.processingLeaseUntil} <= NOW())
                OR (${webhookEvents.processingLeaseUntil} IS NULL AND ${webhookEvents.updatedAt} <= ${staleBefore})))
          )`,
      )
      .orderBy(webhookEvents.receivedAt)
      .limit(limit)) as WebhookEvent[];
  }

  async claimForDispatch(
    id: string,
    leaseUntil: string,
    staleBefore: string,
    maxDispatchAttempts: number,
  ): Promise<WebhookEvent | null> {
    const rows = (await this.db
      .update(webhookEvents)
      .set({
        status: 'pending',
        dispatchAttempts: sql`${webhookEvents.dispatchAttempts} + 1`,
        dispatchLeaseUntil: leaseUntil,
        dispatchedAt: null,
        processingLeaseUntil: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        sql`${webhookEvents.id} = ${id}
          AND ${webhookEvents.dispatchRequired} = true
          AND ${webhookEvents.dispatchAttempts} < ${maxDispatchAttempts}
          AND (
            (${webhookEvents.status} = 'pending'
              AND ${webhookEvents.dispatchedAt} IS NULL
              AND (${webhookEvents.nextDispatchAt} IS NULL OR ${webhookEvents.nextDispatchAt} <= NOW())
              AND (${webhookEvents.dispatchLeaseUntil} IS NULL OR ${webhookEvents.dispatchLeaseUntil} <= NOW()))
            OR
            (${webhookEvents.status} = 'processing'
              AND ((${webhookEvents.processingLeaseUntil} IS NOT NULL AND ${webhookEvents.processingLeaseUntil} <= NOW())
                OR (${webhookEvents.processingLeaseUntil} IS NULL AND ${webhookEvents.updatedAt} <= ${staleBefore})))
          )`,
      )
      .returning()) as WebhookEvent[];

    return rows[0] ?? null;
  }

  async markDispatched(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(webhookEvents)
      .set({
        dispatchedAt: now,
        dispatchLeaseUntil: null,
        nextDispatchAt: null,
        lastDispatchError: null,
        updatedAt: now,
      })
      .where(eq(webhookEvents.id, id));
  }

  async markDispatchFailed(
    id: string,
    error: string,
    terminal: boolean,
    nextDispatchAt: string | null,
  ): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: terminal ? 'failed' : 'pending',
        lastDispatchError: error,
        lastError: terminal ? `dispatch_terminal:${error}` : undefined,
        dispatchLeaseUntil: null,
        nextDispatchAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(webhookEvents.id, id));
  }

  async claimForProcessing(
    id: string,
    leaseUntil: string,
  ): Promise<'claimed' | 'busy' | 'terminal' | 'missing'> {
    const rows = await this.db
      .update(webhookEvents)
      .set({
        status: 'processing',
        processingLeaseUntil: leaseUntil,
        updatedAt: new Date().toISOString(),
      })
      .where(
        sql`${webhookEvents.id} = ${id}
          AND (
            ${webhookEvents.status} = 'pending'
            OR (${webhookEvents.status} = 'processing'
              AND (${webhookEvents.processingLeaseUntil} IS NULL OR ${webhookEvents.processingLeaseUntil} <= NOW()))
          )`,
      )
      .returning({ id: webhookEvents.id });

    if (rows.length > 0) return 'claimed';
    const event = await this.findById(id);
    if (!event) return 'missing';
    if (['completed', 'skipped', 'failed'].includes(event.status))
      return 'terminal';
    return 'busy';
  }

  async markProcessingRetryable(
    id: string,
    error: string,
    attempts: number,
  ): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: 'pending',
        attempts,
        lastError: error,
        processingLeaseUntil: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(webhookEvents.id, id));
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
        processingLeaseUntil: null,
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
        processingLeaseUntil: null,
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
        processingLeaseUntil: null,
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
    storeDomain: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const rows = (await this.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        sql`${webhookEvents.platform} = ${platform} AND ${webhookEvents.storeDomain} = ${storeDomain} AND ${webhookEvents.idempotencyKey} = ${idempotencyKey}`,
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
