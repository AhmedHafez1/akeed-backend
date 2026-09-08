import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql, eq } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { orders, verifications, webhookEvents } from '../schema';

interface WebhookEventInsert {
  platform: string;
  jobType: string;
  idempotencyKey: string;
  storeDomain: string;
  orgId?: string | null;
  integrationId?: string | null;
  orderId?: string | null;
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
  orderId: string | null;
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
        orderId: event.orderId ?? null,
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

  /**
   * The single definition of "this event still needs dispatching".
   *
   * `findRecoverable` sweeps with it and `claimForDispatch` claims with it. If
   * the two ever disagree the reconciler reports candidates it cannot claim, or
   * worse, stops reporting events that are genuinely stuck -- so they share one
   * fragment rather than two copies that have to be kept in step by hand.
   */
  private recoverablePredicate(
    staleBefore: string,
    maxDispatchAttempts: number,
  ) {
    return sql`${webhookEvents.dispatchRequired} = true
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
        OR
        (${webhookEvents.status} = 'pending'
          AND ${webhookEvents.dispatchedAt} IS NOT NULL
          AND ${webhookEvents.dispatchedAt} <= ${staleBefore})
      )`;
  }

  async findRecoverable(
    limit: number,
    staleBefore: string,
    maxDispatchAttempts: number,
  ): Promise<WebhookEvent[]> {
    return (await this.db
      .select()
      .from(webhookEvents)
      .where(this.recoverablePredicate(staleBefore, maxDispatchAttempts))
      .orderBy(webhookEvents.receivedAt)
      .limit(limit)) as WebhookEvent[];
  }

  /**
   * Orders that were accepted but have no verification and no terminal event.
   *
   * The event-level sweep above can only recover events whose own bookkeeping
   * says they are stuck. This pass asks the question the merchant actually
   * cares about -- "was this order verified?" -- so an order stranded by a hole
   * we have not thought of is still picked up.
   *
   * `completed`, `skipped` and `failed` are excluded deliberately: a skip is a
   * decision (plan limit reached, source inactive, identity mismatch), not a
   * fault, and re-driving those would loop forever.
   */
  async findOrdersMissingVerification(
    limit: number,
    olderThan: string,
  ): Promise<Array<{ eventId: string; orderId: string }>> {
    const rows = await this.db
      .select({ eventId: webhookEvents.id, orderId: orders.id })
      .from(orders)
      .innerJoin(
        webhookEvents,
        sql`${webhookEvents.orderId} = ${orders.id} AND ${webhookEvents.jobType} = 'order.create'`,
      )
      .leftJoin(verifications, sql`${verifications.orderId} = ${orders.id}`)
      .where(
        sql`${verifications.id} IS NULL
          AND ${webhookEvents.status} NOT IN ('completed', 'skipped', 'failed')
          AND ${orders.createdAt} <= ${olderThan}`,
      )
      .orderBy(orders.createdAt)
      .limit(limit);
    return rows as Array<{ eventId: string; orderId: string }>;
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
          AND ${this.recoverablePredicate(staleBefore, maxDispatchAttempts)}`,
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

  /**
   * `retryDelayMs` rather than a timestamp: the value is compared against the
   * database's `NOW()` by the claim predicate, so the database has to be the
   * one that computes it. An app clock running ahead of Postgres would
   * otherwise park the row in the future and stall its own retry.
   */
  async markDispatchFailed(
    id: string,
    error: string,
    terminal: boolean,
    retryDelayMs: number | null,
  ): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({
        status: terminal ? 'failed' : 'pending',
        lastDispatchError: error,
        lastError: terminal ? `dispatch_terminal:${error}` : undefined,
        dispatchLeaseUntil: null,
        nextDispatchAt:
          retryDelayMs === null
            ? null
            : sql`NOW() + make_interval(secs => ${retryDelayMs / 1000})`,
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

  /**
   * Attach a processed event to the order it produced.
   *
   * Manual ingestion writes the link inside its acceptance transaction, but a
   * webhook creates its order later, inside the worker. Without this link a
   * webhook-created order has no durable event to re-dispatch, so merchant
   * retry could never work for it.
   *
   * A partial unique index allows one event per order, so the write is
   * conditional on both sides and silently yields if the order is already
   * claimed.
   */
  async linkOrder(id: string, orderId: string): Promise<boolean> {
    const rows = await this.db
      .update(webhookEvents)
      .set({ orderId, updatedAt: new Date().toISOString() })
      .where(
        sql`${webhookEvents.id} = ${id}
          AND ${webhookEvents.orderId} IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${webhookEvents} AS claimed
            WHERE claimed.order_id = ${orderId}
          )`,
      )
      .returning({ id: webhookEvents.id });
    return rows.length === 1;
  }

  async resetForRedispatch(params: {
    id: string;
    orderId: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await this.db
      .update(webhookEvents)
      .set({
        status: 'pending',
        dispatchAttempts: 0,
        lastDispatchError: null,
        nextDispatchAt: sql`NOW()`,
        dispatchLeaseUntil: null,
        dispatchedAt: null,
        processingLeaseUntil: null,
        lastError: null,
        processedAt: null,
        updatedAt: now,
      })
      .where(
        sql`${webhookEvents.id} = ${params.id}
          AND ${webhookEvents.orderId} = ${params.orderId}
          AND ${webhookEvents.status} IN ('completed', 'failed', 'skipped')`,
      )
      .returning({ id: webhookEvents.id });
    return rows.length === 1;
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
