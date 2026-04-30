import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { and, eq, gte, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import { DRIZZLE } from '../database.provider';
import { verifications } from '../schema';

/**
 * Terminal statuses that must never be overwritten by later webhook events
 * (delivery/read/failed). Note: `no_reply` is also protected from webhook
 * status updates but can still be overridden by customer button replies.
 */
const TERMINAL_STATUSES: VerificationStatus[] = ['confirmed', 'canceled'];

/**
 * Statuses that webhook delivery/read/failed events must not overwrite.
 * This is a superset of TERMINAL_STATUSES — it additionally blocks
 * late webhook events from reverting a no_reply escalation.
 */
const WEBHOOK_PROTECTED_STATUSES: VerificationStatus[] = [
  'confirmed',
  'canceled',
  'no_reply',
];

/**
 * Converts a Meta webhook Unix-epoch string (seconds) to an ISO-8601 string.
 * Falls back to the current server time when the input is missing or invalid.
 */
function toIsoTimestamp(epochSeconds?: string): string {
  if (epochSeconds) {
    const ms = Number(epochSeconds) * 1000;
    if (Number.isFinite(ms) && ms > 0) {
      return new Date(ms).toISOString();
    }
  }
  return new Date().toISOString();
}

@Injectable()
export class VerificationsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async getFunnelCountsByOrgAndPeriod(
    orgId: string,
    startAt: string,
    endAt: string,
  ): Promise<{
    total: number;
    confirmed: number;
    canceled: number;
    customerCanceled: number;
    sent: number;
    delivered: number;
    read: number;
  }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        sent: sql<number>`count(${verifications.lastSentAt})::int`,
        delivered: sql<number>`count(${verifications.deliveredAt})::int`,
        read: sql<number>`count(${verifications.readAt})::int`,
        confirmed: sql<number>`count(${verifications.confirmedAt})::int`,
        canceled: sql<number>`count(${verifications.canceledAt})::int`,
        customerCanceled: sql<number>`count(CASE WHEN ${verifications.canceledAt} IS NOT NULL AND (${verifications.cancellationSource} IS NULL OR ${verifications.cancellationSource} = 'customer') THEN 1 END)::int`,
      })
      .from(verifications)
      .where(
        and(
          eq(verifications.orgId, orgId),
          gte(verifications.createdAt, startAt),
          lt(verifications.createdAt, endAt),
        ),
      );

    return {
      total: row?.total ?? 0,
      sent: row?.sent ?? 0,
      delivered: row?.delivered ?? 0,
      read: row?.read ?? 0,
      confirmed: row?.confirmed ?? 0,
      canceled: row?.canceled ?? 0,
      customerCanceled: row?.customerCanceled ?? 0,
    };
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
        order: Pick<
          typeof schema.orders.$inferSelect,
          | 'orderNumber'
          | 'customerName'
          | 'customerPhone'
          | 'totalPrice'
          | 'currency'
        > | null;
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
        order: {
          columns: {
            orderNumber: true,
            customerName: true,
            customerPhone: true,
            totalPrice: true,
            currency: true,
          },
        },
      },
      orderBy: (verifications, { desc }) => [
        desc(verifications.createdAt),
        desc(verifications.id),
      ],
      limit,
    });
  }

  /**
   * Update a verification by its primary key.
   *
   * - Sets the lifecycle timestamp column that corresponds to the target status.
   * - Backfills earlier milestone timestamps when a later milestone arrives
   *   (e.g. `read` implies `delivered`; `confirmed`/`canceled` imply both).
   * - Refuses to overwrite terminal statuses (`confirmed` / `canceled`).
   * - Writes `last_sent_at` and increments `attempts` when status is `sent`.
   * - Allows customer button replies (confirmed/canceled) to override `no_reply`.
   * - Accepts optional extra fields to merge into the SET payload.
   */
  async updateStatus(
    id: string,
    status: VerificationStatus,
    waMessageId?: string,
    eventTimestamp?: string,
    extraUpdates?: Record<string, unknown>,
  ) {
    const now = new Date().toISOString();
    const eventTs = toIsoTimestamp(eventTimestamp);

    const setPayload = this.buildLifecyclePayload(status, eventTs, now);
    if (waMessageId !== undefined) {
      setPayload.waMessageId = waMessageId;
    }
    if (extraUpdates) {
      Object.assign(setPayload, extraUpdates);
    }

    // For confirmed/canceled (customer replies), also allow overriding no_reply
    const isCustomerReply = status === 'confirmed' || status === 'canceled';
    const blockedStatuses = isCustomerReply
      ? TERMINAL_STATUSES
      : [...TERMINAL_STATUSES, 'no_reply' as VerificationStatus];

    return await this.db
      .update(verifications)
      .set(setPayload)
      .where(
        and(
          eq(verifications.id, id),
          notInArray(verifications.status, blockedStatuses),
        ),
      )
      .returning();
  }

  /**
   * Update a verification by its WhatsApp message id (wamid).
   *
   * Same lifecycle-aware semantics as `updateStatus`, but uses
   * WEBHOOK_PROTECTED_STATUSES to additionally block late delivery/read/failed
   * events from overwriting a no_reply escalation.
   */
  async updateStatusByWamid(
    wamid: string,
    status: VerificationStatus,
    eventTimestamp?: string,
  ) {
    const now = new Date().toISOString();
    const eventTs = toIsoTimestamp(eventTimestamp);

    const setPayload = this.buildLifecyclePayload(status, eventTs, now);

    return await this.db
      .update(verifications)
      .set(setPayload)
      .where(
        and(
          eq(verifications.waMessageId, wamid),
          notInArray(verifications.status, WEBHOOK_PROTECTED_STATUSES),
        ),
      )
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

  /**
   * Mark a follow-up WhatsApp message as sent.
   *
   * - Updates `followUpSentAt` to the current time.
   * - Increments `followUpAttempts` (preserving the existing count).
   * - Replaces `waMessageId` with the latest follow-up wamid (so subsequent
   *   delivery/read webhooks update this verification record).
   * - Refuses to overwrite terminal statuses (confirmed/canceled).
   */
  async markFollowUpSent(id: string, waMessageId: string) {
    const now = new Date().toISOString();
    return await this.db
      .update(verifications)
      .set({
        followUpSentAt: now,
        followUpAttempts: sql`COALESCE(${verifications.followUpAttempts}, 0) + 1`,
        waMessageId,
        updatedAt: now,
      })
      .where(
        and(
          eq(verifications.id, id),
          notInArray(verifications.status, TERMINAL_STATUSES),
        ),
      )
      .returning();
  }

  /**
   * Merge additional keys into the JSONB `metadata` column without dropping
   * existing keys. Performed in-database so concurrent updates do not clobber
   * each other.
   */
  async mergeMetadata(id: string, patch: Record<string, unknown>) {
    return await this.db
      .update(verifications)
      .set({
        metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(verifications.id, id))
      .returning();
  }

  /**
   * Find a verification by its primary key, scoped to an organization.
   */
  async findByIdForOrg(verificationId: string, orgId: string) {
    return await this.db.query.verifications.findFirst({
      where: and(
        eq(verifications.id, verificationId),
        eq(verifications.orgId, orgId),
      ),
    });
  }

  /**
   * Update a verification by its primary key, scoped to an organization.
   */
  async updateByIdForOrg(
    verificationId: string,
    orgId: string,
    updates: Partial<typeof verifications.$inferInsert>,
  ) {
    const [result] = await this.db
      .update(verifications)
      .set({
        ...updates,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(verifications.id, verificationId),
          eq(verifications.orgId, orgId),
        ),
      )
      .returning();
    return result;
  }

  /**
   * Build the SET payload for a lifecycle-aware status update.
   *
   * Uses COALESCE in SQL so that earlier milestone timestamps are only
   * written when they are still NULL, preserving the original event time.
   */
  private buildLifecyclePayload(
    status: VerificationStatus,
    eventTs: string,
    now: string,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      status: status as typeof verifications.$inferSelect.status,
      updatedAt: now,
    };

    switch (status) {
      case 'sent':
        payload.lastSentAt = eventTs;
        payload.attempts = sql`COALESCE(${verifications.attempts}, 0) + 1`;
        break;

      case 'delivered':
        payload.deliveredAt = sql`COALESCE(${verifications.deliveredAt}, ${eventTs})`;
        break;

      case 'read':
        payload.deliveredAt = sql`COALESCE(${verifications.deliveredAt}, ${eventTs})`;
        payload.readAt = sql`COALESCE(${verifications.readAt}, ${eventTs})`;
        break;

      case 'confirmed':
        payload.deliveredAt = sql`COALESCE(${verifications.deliveredAt}, ${eventTs})`;
        payload.readAt = sql`COALESCE(${verifications.readAt}, ${eventTs})`;
        payload.confirmedAt = eventTs;
        break;

      case 'canceled':
        payload.deliveredAt = sql`COALESCE(${verifications.deliveredAt}, ${eventTs})`;
        payload.readAt = sql`COALESCE(${verifications.readAt}, ${eventTs})`;
        payload.canceledAt = eventTs;
        break;

      case 'no_reply':
        payload.noReplyAt = eventTs;
        break;

      default:
        break;
    }

    return payload;
  }
}
