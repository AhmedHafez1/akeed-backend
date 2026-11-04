import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { metaWebhookEvents } from '../schema';
import { withSerializableRetry } from '../../../shared/database/serializable-retry';

export type MetaWebhookEvent = typeof metaWebhookEvents.$inferSelect;

export interface NewMetaWebhookEvent {
  dedupeHash: string;
  field: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  payload: string;
}

export interface DueMetaWebhookEvent {
  id: string;
  attempts: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Stored Meta webhook events. Not tenant data: a row belongs to Meta's
 * delivery, and no organization is known until a handler has read it.
 *
 * A running event's writes all filter on `attempts`, which its claim raised.
 * A worker that stalled past its lease therefore cannot overwrite a newer run.
 */
@Injectable()
export class MetaWebhookEventsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Intake admission and event persistence share the locks used by customer redaction. */
  async insertManyPrepared(
    events: readonly NewMetaWebhookEvent[],
    nextAttemptAt: string,
    prepare: (payload: string, db: DrizzleDB) => Promise<string>,
  ): Promise<{ id: string }[]> {
    return withSerializableRetry(() =>
      this.db.transaction(async (tx) => {
        const prepared: NewMetaWebhookEvent[] = [];
        for (const event of events)
          prepared.push({
            ...event,
            payload:
              event.field === null
                ? '{"entry":[]}'
                : await prepare(event.payload, tx as unknown as DrizzleDB),
          });
        return new MetaWebhookEventsRepository(
          tx as unknown as DrizzleDB,
        ).insertMany(prepared, nextAttemptAt);
      }),
    );
  }

  /**
   * One statement, so a POST is either fully stored or not at all. Answers the
   * rows that are new; a redelivered change is left out.
   */
  async insertMany(
    events: readonly NewMetaWebhookEvent[],
    nextAttemptAt: string,
  ): Promise<{ id: string }[]> {
    return this.db
      .insert(metaWebhookEvents)
      .values(events.map((event) => ({ ...event, nextAttemptAt })))
      .onConflictDoNothing({ target: metaWebhookEvents.dedupeHash })
      .returning({ id: metaWebhookEvents.id });
  }

  /** Takes an event to run, or nothing if another run holds it or it is done. */
  async claim(
    id: string,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<MetaWebhookEvent | undefined> {
    const now = Date.now();
    const [row] = await this.db
      .update(metaWebhookEvents)
      .set({
        status: 'processing',
        attempts: sql`${metaWebhookEvents.attempts} + 1`,
        leaseUntil: iso(now + leaseMs),
      })
      .where(
        and(
          eq(metaWebhookEvents.id, id),
          isNotNull(metaWebhookEvents.payload),
          lt(metaWebhookEvents.attempts, maxAttempts),
          sql`(${metaWebhookEvents.status} = 'pending' OR (${metaWebhookEvents.status} = 'processing' AND ${metaWebhookEvents.leaseUntil} < ${iso(now)}::timestamptz))`,
        ),
      )
      .returning();
    return row;
  }

  /** Clears the payload and keeps the hash. */
  async markSucceeded(id: string, attempts: number): Promise<void> {
    await this.db
      .update(metaWebhookEvents)
      .set({
        status: 'succeeded',
        payload: null,
        processedAt: iso(Date.now()),
        leaseUntil: null,
        nextAttemptAt: null,
        lastError: null,
      })
      .where(this.running(id, attempts));
  }

  /** Back to waiting; the sweep takes it after `nextAttemptAt` if no job does. */
  async release(
    id: string,
    attempts: number,
    error: string,
    nextAttemptAt: string,
  ): Promise<void> {
    await this.db
      .update(metaWebhookEvents)
      .set({
        status: 'pending',
        leaseUntil: null,
        nextAttemptAt,
        lastError: error,
      })
      .where(this.running(id, attempts));
  }

  /** Stays visible, with its payload, until the purge. */
  async markFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.db
      .update(metaWebhookEvents)
      .set({
        status: 'failed',
        failedAt: iso(Date.now()),
        leaseUntil: null,
        nextAttemptAt: null,
        lastError: error,
      })
      .where(this.running(id, attempts));
  }

  private running(id: string, attempts: number) {
    return and(
      eq(metaWebhookEvents.id, id),
      eq(metaWebhookEvents.status, 'processing'),
      eq(metaWebhookEvents.attempts, attempts),
    );
  }

  /** Events the sweep would take but that have no attempts left. */
  async failExhausted(maxAttempts: number): Promise<number> {
    const now = iso(Date.now());
    const rows = await this.db
      .update(metaWebhookEvents)
      .set({
        status: 'failed',
        failedAt: now,
        leaseUntil: null,
        nextAttemptAt: null,
        lastError: 'attempts_exhausted',
      })
      .where(
        and(
          sql`${metaWebhookEvents.attempts} >= ${maxAttempts}`,
          sql`((${metaWebhookEvents.status} = 'pending' AND ${metaWebhookEvents.nextAttemptAt} <= ${now}::timestamptz) OR (${metaWebhookEvents.status} = 'processing' AND ${metaWebhookEvents.leaseUntil} < ${now}::timestamptz))`,
        ),
      )
      .returning({ id: metaWebhookEvents.id });
    return rows.length;
  }

  /**
   * Takes events that were never queued, lost their job, or were left behind
   * by a crash. Moving `next_attempt_at` in the same statement keeps two
   * replicas off one row, and retries it later if the enqueue then fails.
   */
  async claimDue(
    limit: number,
    retryAfterMs: number,
  ): Promise<DueMetaWebhookEvent[]> {
    const now = Date.now();
    const nowIso = iso(now);
    const rows = await this.db.execute(sql`
      WITH due AS (
        SELECT id FROM meta_webhook_events
        WHERE (status = 'pending' AND next_attempt_at <= ${nowIso}::timestamptz)
           OR (status = 'processing' AND lease_until < ${nowIso}::timestamptz)
        ORDER BY received_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE meta_webhook_events AS event
      SET status = 'pending',
          lease_until = NULL,
          next_attempt_at = ${iso(now + retryAfterMs)}::timestamptz
      FROM due
      WHERE event.id = due.id
      RETURNING event.id, event.attempts
    `);
    return [...rows] as unknown as DueMetaWebhookEvent[];
  }

  /**
   * Retention: a failed event's payload after `payloadDays`, and the row of a
   * finished event after `rowDays`. Waiting events are the sweep's, not this.
   */
  async purge(
    payloadDays: number,
    rowDays: number,
  ): Promise<{ payloadsCleared: number; rowsDeleted: number }> {
    const day = 24 * 60 * 60 * 1000;
    const cleared = await this.db
      .update(metaWebhookEvents)
      .set({ payload: null })
      .where(
        and(
          eq(metaWebhookEvents.status, 'failed'),
          isNotNull(metaWebhookEvents.payload),
          lt(metaWebhookEvents.failedAt, iso(Date.now() - payloadDays * day)),
        ),
      )
      .returning({ id: metaWebhookEvents.id });
    const deleted = await this.db
      .delete(metaWebhookEvents)
      .where(
        and(
          inArray(metaWebhookEvents.status, ['succeeded', 'failed']),
          lt(metaWebhookEvents.receivedAt, iso(Date.now() - rowDays * day)),
        ),
      )
      .returning({ id: metaWebhookEvents.id });
    return { payloadsCleared: cleared.length, rowsDeleted: deleted.length };
  }
}
