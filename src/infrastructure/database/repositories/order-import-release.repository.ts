import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { orderImportBatches, orderImportRows, webhookEvents } from '../schema';
import { isUniqueViolation } from './order-imports.repository';

type Database = PostgresJsDatabase<typeof schema>;

/** The batch fields start, stop, resume and the quote decide on. */
export interface BatchForRelease {
  id: string;
  orgId: string;
  integrationId: string;
  status: string;
  startDeadlineAt: string | null;
  startIdempotencyKey: string | null;
  pausedReason: string | null;
  /** A draft whose mapping the merchant saved: its rows are validated. */
  mappingConfirmed: boolean;
  /** Rows that will be imported, as the last validation counted them. */
  readyCount: number;
}

export interface ReleasingBatch {
  id: string;
  integrationId: string;
  startedAt: string | null;
}

export interface HoldCounts {
  held: number;
  released: number;
  withdrawn: number;
}

export interface HeldEventForRelease {
  eventId: string;
  batchId: string;
}

export type ClaimForStartResult = 'claimed' | 'not_startable' | 'key_taken';

/** Batch statuses a start deadline applies to. */
const STARTABLE_STATUSES = ['awaiting_start', 'paused'] as const;

/**
 * One entry appended to `events` inside the same UPDATE that makes the
 * transition, so the log can never disagree with the status.
 */
function appendEvent(
  type: string,
  at: string,
  extra: Record<string, unknown> = {},
): SQL {
  return sql`${orderImportBatches.events} || ${JSON.stringify([
    { type, at, ...extra },
  ])}::jsonb`;
}

/**
 * Batch transitions for the start checkpoint and paced release (US-04.6-07).
 *
 * Every transition is one conditional UPDATE guarded by the status it leaves,
 * so a double click, a retry and a racing release tick each either win or see
 * nothing change. Held events themselves move only through the guarded
 * `WebhookEventsRepository.releaseHeld` / `withdrawHeld`.
 */
@Injectable()
export class OrderImportReleaseRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findBatch(
    orgId: string,
    batchId: string,
  ): Promise<BatchForRelease | null> {
    const [row] = await this.db
      .select({
        id: orderImportBatches.id,
        orgId: orderImportBatches.orgId,
        integrationId: orderImportBatches.integrationId,
        status: orderImportBatches.status,
        startDeadlineAt: orderImportBatches.startDeadlineAt,
        startIdempotencyKey: orderImportBatches.startIdempotencyKey,
        pausedReason: orderImportBatches.pausedReason,
        mappingConfirmed: sql<boolean>`coalesce((${orderImportBatches.mapping} ->> 'confirmed')::boolean, false)`,
        readyCount: sql<number>`coalesce((${orderImportBatches.counts} ->> 'ready')::int, 0)`,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, batchId),
          eq(orderImportBatches.orgId, orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Held, released and withdrawn events of one batch, from the events. */
  async holdCounts(orgId: string, batchId: string): Promise<HoldCounts> {
    const rows = await this.db
      .select({
        state: webhookEvents.holdState,
        count: sql<number>`count(*)::int`,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.orgId, orgId),
          eq(webhookEvents.holdGroupId, batchId),
        ),
      )
      .groupBy(webhookEvents.holdState);
    const counts: HoldCounts = { held: 0, released: 0, withdrawn: 0 };
    for (const row of rows) {
      if (row.state in counts)
        counts[row.state as keyof HoldCounts] = Number(row.count);
    }
    return counts;
  }

  /**
   * `awaiting_start` → `releasing`, recording the merchant's attestation.
   *
   * The deadline is re-checked here, not only by the caller, so a start that
   * races the expiry job cannot resurrect a batch whose holds it withdrew.
   */
  async claimForStart(input: {
    orgId: string;
    batchId: string;
    key: string;
    attestedBy: string;
    attestationVersion: string;
    orders: number;
    now: Date;
  }): Promise<ClaimForStartResult> {
    const now = input.now.toISOString();
    try {
      const [row] = await this.db
        .update(orderImportBatches)
        .set({
          status: 'releasing',
          attestedBy: input.attestedBy,
          attestedAt: now,
          attestationVersion: input.attestationVersion,
          startedAt: now,
          startIdempotencyKey: input.key,
          pausedReason: null,
          events: appendEvent('started', now, {
            by: input.attestedBy,
            orders: input.orders,
            attestationVersion: input.attestationVersion,
          }),
          updatedAt: now,
        })
        .where(
          and(
            eq(orderImportBatches.id, input.batchId),
            eq(orderImportBatches.orgId, input.orgId),
            eq(orderImportBatches.status, 'awaiting_start'),
            sql`${orderImportBatches.startDeadlineAt} > ${now}`,
          ),
        )
        .returning({ id: orderImportBatches.id });
      return row ? 'claimed' : 'not_startable';
    } catch (error) {
      if (isUniqueViolation(error)) return 'key_taken';
      throw error;
    }
  }

  /** `paused` → `releasing`; the attestation from the start still applies. */
  async resume(input: {
    orgId: string;
    batchId: string;
    now: Date;
  }): Promise<boolean> {
    const now = input.now.toISOString();
    const [row] = await this.db
      .update(orderImportBatches)
      .set({
        status: 'releasing',
        pausedReason: null,
        // Reads the pre-update row, so the log keeps what the pause was for.
        events: sql`${orderImportBatches.events} || jsonb_build_array(jsonb_build_object('type', 'resumed', 'at', ${now}::text, 'from', ${orderImportBatches.pausedReason}))`,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.orgId, input.orgId),
          eq(orderImportBatches.status, 'paused'),
          sql`${orderImportBatches.pausedReason} IS DISTINCT FROM 'staff_paused'`,
          sql`${orderImportBatches.startDeadlineAt} > ${now}`,
        ),
      )
      .returning({ id: orderImportBatches.id });
    return Boolean(row);
  }

  /** `releasing` or `paused` → `stopped`. Withdrawing the holds follows. */
  async markStopped(input: {
    orgId: string;
    batchId: string;
    now: Date;
  }): Promise<boolean> {
    const now = input.now.toISOString();
    const [row] = await this.db
      .update(orderImportBatches)
      .set({
        status: 'stopped',
        stoppedAt: now,
        quietHoursUntil: null,
        events: appendEvent('stopped', now),
        updatedAt: now,
      })
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.orgId, input.orgId),
          inArray(orderImportBatches.status, ['releasing', 'paused']),
        ),
      )
      .returning({ id: orderImportBatches.id });
    return Boolean(row);
  }

  async listReleasing(orgId: string): Promise<ReleasingBatch[]> {
    return this.db
      .select({
        id: orderImportBatches.id,
        integrationId: orderImportBatches.integrationId,
        startedAt: orderImportBatches.startedAt,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.status, 'releasing'),
        ),
      )
      .orderBy(asc(orderImportBatches.startedAt), asc(orderImportBatches.id));
  }

  /** Organizations whose release scheduler must exist (worker boot). */
  async listOrgsWithReleasing(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ orgId: orderImportBatches.orgId })
      .from(orderImportBatches)
      .where(eq(orderImportBatches.status, 'releasing'));
    return rows.map((row) => row.orgId);
  }

  /** Shown on releasing batches while the store is in quiet hours. */
  async setQuietHoursUntil(
    orgId: string,
    until: string | null,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(orderImportBatches)
      .set({ quietHoursUntil: until, updatedAt: now.toISOString() })
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.status, 'releasing'),
          sql`${orderImportBatches.quietHoursUntil} IS DISTINCT FROM ${until}`,
        ),
      );
  }

  /**
   * Pause every releasing batch of the organization for one blocker. The
   * blocker is the source's (credits, auto-verify, setup), so it stops all of
   * that source's imports at once.
   */
  async pauseReleasing(
    orgId: string,
    reason: string,
    now: Date,
  ): Promise<string[]> {
    const at = now.toISOString();
    const rows = await this.db
      .update(orderImportBatches)
      .set({
        status: 'paused',
        pausedReason: reason,
        quietHoursUntil: null,
        events: appendEvent('paused', at, { reason }),
        updatedAt: at,
      })
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.status, 'releasing'),
        ),
      )
      .returning({ id: orderImportBatches.id });
    return rows.map((row) => row.id);
  }

  /**
   * The next held events to release for the organization, across its
   * releasing batches: the earliest-started batch first, then file order.
   */
  async selectHeldForRelease(
    orgId: string,
    limit: number,
  ): Promise<HeldEventForRelease[]> {
    if (limit <= 0) return [];
    return this.db
      .select({
        eventId: webhookEvents.id,
        batchId: orderImportBatches.id,
      })
      .from(webhookEvents)
      .innerJoin(
        orderImportBatches,
        and(
          eq(orderImportBatches.id, webhookEvents.holdGroupId),
          eq(orderImportBatches.orgId, webhookEvents.orgId),
        ),
      )
      .innerJoin(
        orderImportRows,
        and(
          eq(orderImportRows.webhookEventId, webhookEvents.id),
          eq(orderImportRows.batchId, orderImportBatches.id),
        ),
      )
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.status, 'releasing'),
          eq(webhookEvents.holdState, 'held'),
        ),
      )
      .orderBy(
        asc(orderImportBatches.startedAt),
        asc(orderImportBatches.id),
        asc(orderImportRows.rowNumber),
      )
      .limit(limit);
  }

  /** Releasing batches with nothing left to release become `completed`. */
  async completeDrained(orgId: string, now: Date): Promise<string[]> {
    const at = now.toISOString();
    const rows = await this.db
      .update(orderImportBatches)
      .set({
        status: 'completed',
        completedAt: at,
        quietHoursUntil: null,
        events: appendEvent('completed', at),
        updatedAt: at,
      })
      .where(
        and(
          eq(orderImportBatches.orgId, orgId),
          eq(orderImportBatches.status, 'releasing'),
          sql`NOT EXISTS (
            SELECT 1 FROM ${webhookEvents}
            WHERE ${webhookEvents.orgId} = ${orderImportBatches.orgId}
              AND ${webhookEvents.holdGroupId} = ${orderImportBatches.id}
              AND ${webhookEvents.holdState} = 'held'
          )`,
        ),
      )
      .returning({ id: orderImportBatches.id });
    return rows.map((row) => row.id);
  }

  /** Never-started or paused batches whose start window has passed. */
  async listPastStartDeadline(
    now: Date,
    limit: number,
  ): Promise<Array<{ id: string; orgId: string }>> {
    return this.db
      .select({ id: orderImportBatches.id, orgId: orderImportBatches.orgId })
      .from(orderImportBatches)
      .where(
        and(
          inArray(orderImportBatches.status, [...STARTABLE_STATUSES]),
          lte(orderImportBatches.startDeadlineAt, now.toISOString()),
        ),
      )
      .orderBy(asc(orderImportBatches.startDeadlineAt))
      .limit(limit);
  }

  /** The start window lapsed: `awaiting_start` or `paused` → `not_started`. */
  async markNotStarted(input: {
    orgId: string;
    batchId: string;
    now: Date;
  }): Promise<boolean> {
    const now = input.now.toISOString();
    const [row] = await this.db
      .update(orderImportBatches)
      .set({
        status: 'not_started',
        quietHoursUntil: null,
        events: appendEvent('not_started', now),
        updatedAt: now,
      })
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.orgId, input.orgId),
          inArray(orderImportBatches.status, [...STARTABLE_STATUSES]),
          lte(orderImportBatches.startDeadlineAt, now),
        ),
      )
      .returning({ id: orderImportBatches.id });
    return Boolean(row);
  }
}
