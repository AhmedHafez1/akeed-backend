import type { CommerceOutcomeOperationResult } from '../../../shared/commerce/commerce-outcome';
import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { VerificationStatus } from '../../../shared/interfaces/verification.interface';
import { DRIZZLE } from '../database.provider';
import {
  verifications,
  verificationMessageDispatches,
  creditReservations,
  orderImportRows,
  orders,
  webhookEvents,
} from '../schema';
import {
  RETRYABLE_VERIFICATION_REASONS,
  TERMINAL_STATUSES,
  WEBHOOK_PROTECTED_STATUSES,
} from '../../../shared/verification/verification-lifecycle';
import type {
  NeedsActionReason,
  VerificationListTab,
} from '../../../shared/verification/verification-needs-action';
import type { OverviewCounts } from '../../../shared/verification/verification-metrics';
import {
  needsActionReasonSql,
  type NeedsActionContext,
} from './verification-needs-action.sql';

/** Statuses a merchant may confirm by hand: a message went out, no answer yet. */
export const MANUALLY_CONFIRMABLE_STATUSES: VerificationStatus[] = [
  'sent',
  'delivered',
  'read',
  'no_reply',
  'failed',
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
    inProgress: number;
    needsAttention: number;
    pending: number;
    failed: number;
    awaitingReply: number;
    confirmed: number;
    canceled: number;
    customerCanceled: number;
    sent: number;
    delivered: number;
    read: number;
    followUpsSent: number;
  }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        // Rolled up here so both dashboards read one definition of "still
        // moving" and "needs me", instead of each summing statuses its own way.
        inProgress: sql<number>`count(CASE WHEN ${verifications.status} IN ('pending', 'sent', 'delivered', 'read') THEN 1 END)::int`,
        needsAttention: sql<number>`count(CASE WHEN ${verifications.status} IN ('failed', 'expired', 'no_reply') THEN 1 END)::int`,
        pending: sql<number>`count(CASE WHEN ${verifications.status} = 'pending' THEN 1 END)::int`,
        failed: sql<number>`count(CASE WHEN ${verifications.status} = 'failed' THEN 1 END)::int`,
        awaitingReply: sql<number>`count(CASE WHEN ${verifications.status} IN ('sent', 'delivered', 'read', 'no_reply') THEN 1 END)::int`,
        sent: sql<number>`count(${verifications.lastSentAt})::int`,
        delivered: sql<number>`count(${verifications.deliveredAt})::int`,
        read: sql<number>`count(${verifications.readAt})::int`,
        confirmed: sql<number>`count(${verifications.confirmedAt})::int`,
        canceled: sql<number>`count(${verifications.canceledAt})::int`,
        customerCanceled: sql<number>`count(CASE WHEN ${verifications.canceledAt} IS NOT NULL AND (${verifications.cancellationSource} IS NULL OR ${verifications.cancellationSource} = 'customer') THEN 1 END)::int`,
        followUpsSent: sql<number>`COALESCE(sum(${verifications.followUpAttempts}), 0)::int`,
      })
      .from(verifications)
      .where(
        and(
          eq(verifications.orgId, orgId),
          gte(verifications.createdAt, startAt),
          lt(verifications.createdAt, endAt),
          this.excludesTestOrders(),
        ),
      );

    return {
      total: row?.total ?? 0,
      inProgress: row?.inProgress ?? 0,
      needsAttention: row?.needsAttention ?? 0,
      pending: row?.pending ?? 0,
      failed: row?.failed ?? 0,
      awaitingReply: row?.awaitingReply ?? 0,
      sent: row?.sent ?? 0,
      delivered: row?.delivered ?? 0,
      read: row?.read ?? 0,
      confirmed: row?.confirmed ?? 0,
      canceled: row?.canceled ?? 0,
      customerCanceled: row?.customerCanceled ?? 0,
      followUpsSent: row?.followUpsSent ?? 0,
    };
  }

  /**
   * Real confirmations since a point in time, for the business-outcome upgrade
   * prompt ("Akeed confirmed 19 orders worth X"). Test orders never count.
   */
  async getConfirmedTotalsByOrgSince(
    orgId: string,
    startAt: string,
  ): Promise<{ count: number; value: string }> {
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        value: sql<string>`COALESCE(sum(${orders.totalPrice}), 0)::text`,
      })
      .from(verifications)
      .innerJoin(orders, eq(verifications.orderId, orders.id))
      .where(
        and(
          eq(verifications.orgId, orgId),
          eq(orders.isTest, false),
          gte(verifications.confirmedAt, startAt),
        ),
      );
    return { count: row?.count ?? 0, value: row?.value ?? '0' };
  }

  /** Dashboard metrics describe real orders; test sends are not business. */
  private excludesTestOrders() {
    return sql`NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${verifications.orderId} AND ${orders.isTest} = true)`;
  }

  async create(data: typeof verifications.$inferInsert) {
    const [result] = await this.db
      .insert(verifications)
      .values(data)
      .returning();
    return result;
  }

  async createForOrderIfAbsent(data: typeof verifications.$inferInsert) {
    const [created] = await this.db
      .insert(verifications)
      .values(data)
      .onConflictDoNothing({ target: verifications.orderId })
      .returning();
    if (created) return { verification: created, created: true };
    const existing = await this.findByOrderId(data.orderId);
    if (!existing) {
      throw new Error('Verification conflict winner could not be reloaded');
    }
    return { verification: existing, created: false };
  }

  async reopenRetryableInitialFailure(
    id: string,
    orgId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(verifications)
      .set({
        status: 'pending',
        metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) - 'reason' - 'kind'`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        sql`${verifications.id} = ${id}
          AND ${verifications.orgId} = ${orgId}
          AND ${verifications.status} = 'failed'
          AND (${verifications.lastSentAt} IS NULL OR EXISTS (
            SELECT 1 FROM ${verificationMessageDispatches} AS dispatch
            JOIN ${creditReservations} AS reservation ON reservation.dispatch_id = dispatch.id AND reservation.org_id = dispatch.org_id
            WHERE dispatch.verification_id = ${verifications.id} AND dispatch.org_id = ${verifications.orgId}
              AND dispatch.kind = 'initial' AND dispatch.accounting_mode = 'prepaid_credit'
              AND dispatch.state = 'accepted' AND dispatch.failed_at IS NOT NULL
              AND reservation.status = 'released'
              AND NOT EXISTS (SELECT 1 FROM ${verificationMessageDispatches} AS newer WHERE newer.verification_id = dispatch.verification_id AND newer.kind = dispatch.kind AND newer.generation > dispatch.generation)
          ))
          AND COALESCE(${verifications.metadata}->>'reason', '') IN (${sql.join(
            RETRYABLE_VERIFICATION_REASONS.map((reason) => sql`${reason}`),
            sql`, `,
          )})`,
      )
      .returning({ id: verifications.id });
    return rows.length === 1;
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

  /**
   * Find a verification by the provider message id of its most recent outbound
   * message.
   *
   * Used to resolve a customer reply that carries no verification id of its own
   * — a free-text answer — via the `context.id` wamid of the template it
   * replies to.
   */
  async findByWaMessageId(wamid: string) {
    return await this.db.query.verifications.findFirst({
      where: eq(verifications.waMessageId, wamid),
    });
  }

  async findByOrg(
    orgId: string,
    statuses?: VerificationStatus[],
    period?: { startAt: string; endAt: string },
    opts?: {
      cursor?: { createdAt: string; id: string };
      limit?: number;
      importBatchId?: string;
    } & VerificationListRefinement,
  ): Promise<
    Array<
      typeof verifications.$inferSelect & {
        actionReason?: NeedsActionReason | null;
        order: Pick<
          typeof schema.orders.$inferSelect,
          | 'orgId'
          | 'integrationId'
          | 'externalOrderId'
          | 'orderNumber'
          | 'customerName'
          | 'customerPhone'
          | 'totalPrice'
          | 'currency'
          | 'isTest'
        > | null;
      }
    >
  > {
    const limit = opts?.limit ?? 50;

    const conditions = this.buildOrgListConditions(
      orgId,
      statuses,
      period,
      opts?.importBatchId,
      opts,
    );

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
      ...(opts?.needsAction
        ? {
            extras: {
              actionReason: needsActionReasonSql(opts.needsAction).as(
                'action_reason',
              ),
            },
          }
        : {}),
      with: {
        order: {
          columns: {
            orgId: true,
            integrationId: true,
            externalOrderId: true,
            orderNumber: true,
            customerName: true,
            customerPhone: true,
            totalPrice: true,
            currency: true,
            isTest: true,
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
   * Count the verifications a `findByOrg` call would return, ignoring the
   * cursor.
   *
   * Shares `buildOrgListConditions` with the list query so the total the
   * dashboard shows can never describe a different filter than the rows.
   */
  async countByOrg(
    orgId: string,
    statuses?: VerificationStatus[],
    period?: { startAt: string; endAt: string },
    importBatchId?: string,
    refinement?: VerificationListRefinement,
  ): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(verifications)
      .where(
        and(
          ...this.buildOrgListConditions(
            orgId,
            statuses,
            period,
            importBatchId,
            refinement,
          ),
        ),
      );

    return row?.value ?? 0;
  }

  /**
   * Row counts for every confirmations tab in one scan.
   *
   * Built from the same conditions as the list (search excluded), so each
   * count is exactly the `total_count` that tab's first page would report.
   */
  async countByTab(
    orgId: string,
    period: { startAt: string; endAt: string },
    needsAction: NeedsActionContext,
    importBatchId?: string,
  ): Promise<
    Record<Exclude<VerificationListTab, 'all'>, number> & { all: number }
  > {
    const reason = needsActionReasonSql(needsAction);
    const [row] = await this.db
      .select({
        all: sql<number>`count(*)::int`,
        needsAction: sql<number>`count(*) FILTER (WHERE ${reason} IS NOT NULL)::int`,
        confirmed: sql<number>`count(*) FILTER (WHERE ${verifications.status} = 'confirmed')::int`,
        canceled: sql<number>`count(*) FILTER (WHERE ${verifications.status} = 'canceled')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${verifications.status} = 'failed')::int`,
      })
      .from(verifications)
      .where(
        and(
          ...this.buildOrgListConditions(
            orgId,
            undefined,
            period,
            importBatchId,
          ),
        ),
      );

    return {
      all: row?.all ?? 0,
      needs_action: row?.needsAction ?? 0,
      confirmed: row?.confirmed ?? 0,
      canceled: row?.canceled ?? 0,
      failed: row?.failed ?? 0,
    };
  }

  /**
   * Everything the embedded dashboard counts, in one aggregate over the
   * period's real (non-test) verifications.
   *
   * The `*AfterSend` numerators only count rows with a recorded send, so every
   * rate built from them is a true share of `sent`.
   */
  async getOverviewCounts(
    orgId: string,
    period: { startAt: string; endAt: string },
    needsAction: NeedsActionContext,
  ): Promise<OverviewCounts & { needsAction: number }> {
    const reason = needsActionReasonSql(needsAction);
    const wasSent = sql`${verifications.lastSentAt} IS NOT NULL`;
    const customerCanceled = sql`${verifications.canceledAt} IS NOT NULL AND (${verifications.cancellationSource} IS NULL OR ${verifications.cancellationSource} = 'customer')`;
    const [row] = await this.db
      .select({
        sent: sql<number>`count(${verifications.lastSentAt})::int`,
        delivered: sql<number>`count(*) FILTER (WHERE ${wasSent} AND ${verifications.deliveredAt} IS NOT NULL)::int`,
        read: sql<number>`count(*) FILTER (WHERE ${wasSent} AND ${verifications.readAt} IS NOT NULL)::int`,
        confirmed: sql<number>`count(${verifications.confirmedAt})::int`,
        confirmedAfterSend: sql<number>`count(*) FILTER (WHERE ${wasSent} AND ${verifications.confirmedAt} IS NOT NULL)::int`,
        customerConfirmedAfterSend: sql<number>`count(*) FILTER (WHERE ${wasSent} AND ${verifications.confirmedAt} IS NOT NULL AND ${verifications.confirmationSource} IS DISTINCT FROM 'merchant_manual')::int`,
        customerCanceled: sql<number>`count(*) FILTER (WHERE ${customerCanceled})::int`,
        customerCanceledAfterSend: sql<number>`count(*) FILTER (WHERE ${wasSent} AND ${customerCanceled})::int`,
        needsAction: sql<number>`count(*) FILTER (WHERE ${reason} IS NOT NULL)::int`,
      })
      .from(verifications)
      .where(
        and(
          eq(verifications.orgId, orgId),
          gte(verifications.createdAt, period.startAt),
          lt(verifications.createdAt, period.endAt),
          this.excludesTestOrders(),
        ),
      );

    return {
      sent: row?.sent ?? 0,
      delivered: row?.delivered ?? 0,
      read: row?.read ?? 0,
      confirmed: row?.confirmed ?? 0,
      confirmedAfterSend: row?.confirmedAfterSend ?? 0,
      customerConfirmedAfterSend: row?.customerConfirmedAfterSend ?? 0,
      customerCanceled: row?.customerCanceled ?? 0,
      customerCanceledAfterSend: row?.customerCanceledAfterSend ?? 0,
      needsAction: row?.needsAction ?? 0,
    };
  }

  /**
   * Value of the period's confirmed real orders, one bucket per currency,
   * largest first. Summed in SQL; amounts come back as exact decimal strings.
   */
  async getConfirmedValueByCurrency(
    orgId: string,
    period: { startAt: string; endAt: string },
  ): Promise<Array<{ currency: string; amount: string }>> {
    const total = sql<string>`COALESCE(sum(${orders.totalPrice}), 0)`;
    const rows = await this.db
      .select({
        currency: sql<string>`COALESCE(${orders.currency}, '')`,
        amount: sql<string>`${total}::text`,
      })
      .from(verifications)
      .innerJoin(
        orders,
        and(
          eq(orders.id, verifications.orderId),
          eq(orders.orgId, verifications.orgId),
        ),
      )
      .where(
        and(
          eq(verifications.orgId, orgId),
          gte(verifications.createdAt, period.startAt),
          lt(verifications.createdAt, period.endAt),
          sql`${verifications.confirmedAt} IS NOT NULL`,
          eq(orders.isTest, false),
          sql`${orders.externalOrderId} NOT LIKE 'akeed-test-%'`,
        ),
      )
      .groupBy(sql`COALESCE(${orders.currency}, '')`)
      .orderBy(desc(total));

    return rows.filter((row) => row.currency !== '');
  }

  /** The period's highest-value orders that need the merchant, for the dashboard card. */
  async findNeedsActionTop(
    orgId: string,
    period: { startAt: string; endAt: string },
    needsAction: NeedsActionContext,
    limit: number,
  ): Promise<NeedsActionRow[]> {
    const reason = needsActionReasonSql(needsAction);
    return this.db
      .select({
        id: verifications.id,
        orderId: verifications.orderId,
        status: verifications.status,
        actionReason: reason,
        metadata: verifications.metadata,
        createdAt: verifications.createdAt,
        lastSentAt: verifications.lastSentAt,
        readAt: verifications.readAt,
        followUpSentAt: verifications.followUpSentAt,
        noReplyAt: verifications.noReplyAt,
        order: {
          orgId: orders.orgId,
          integrationId: orders.integrationId,
          externalOrderId: orders.externalOrderId,
          orderNumber: orders.orderNumber,
          customerName: orders.customerName,
          customerPhone: orders.customerPhone,
          totalPrice: orders.totalPrice,
          currency: orders.currency,
          isTest: orders.isTest,
        },
      })
      .from(verifications)
      .innerJoin(
        orders,
        and(
          eq(orders.id, verifications.orderId),
          eq(orders.orgId, verifications.orgId),
        ),
      )
      .where(
        and(
          eq(verifications.orgId, orgId),
          gte(verifications.createdAt, period.startAt),
          lt(verifications.createdAt, period.endAt),
          sql`${reason} IS NOT NULL`,
        ),
      )
      .orderBy(
        sql`${orders.totalPrice} DESC NULLS LAST`,
        desc(verifications.createdAt),
        desc(verifications.id),
      )
      .limit(limit);
  }

  /**
   * Org + date-range + status filter shared by the list and count queries.
   *
   * The tab and search predicates live here too, rather than in `findByOrg`:
   * both the row query and `countByOrg` read this list, so a filter added here
   * keeps `total_count` describing the same set as the rows it is reported
   * alongside.
   */
  private buildOrgListConditions(
    orgId: string,
    statuses?: VerificationStatus[],
    period?: { startAt: string; endAt: string },
    importBatchId?: string,
    refinement?: VerificationListRefinement,
  ) {
    return [
      eq(verifications.orgId, orgId),
      importBatchId
        ? importBatchRowExists(orgId, importBatchId, verifications.orderId)
        : undefined,
      period ? gte(verifications.createdAt, period.startAt) : undefined,
      period ? lt(verifications.createdAt, period.endAt) : undefined,
      statuses && statuses.length > 0
        ? inArray(verifications.status, statuses)
        : undefined,
      refinement?.tab ? tabCondition(refinement.tab, refinement) : undefined,
      refinement?.searchDigits
        ? orderSearchCondition(orgId, refinement.searchDigits)
        : undefined,
    ].filter(Boolean);
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
    failureInfo?: { code?: number | string; title?: string },
  ) {
    const now = new Date().toISOString();
    const eventTs = toIsoTimestamp(eventTimestamp);

    const setPayload = this.buildLifecyclePayload(
      status,
      eventTs,
      now,
      failureInfo,
    );
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
    failureInfo?: { code?: number | string; title?: string },
  ) {
    const now = new Date().toISOString();
    const eventTs = toIsoTimestamp(eventTimestamp);

    const setPayload = this.buildLifecyclePayload(
      status,
      eventTs,
      now,
      failureInfo,
    );

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
   * Atomically mark a no_reply verification as merchant-canceled.
   *
   * The WHERE clause guards on `id + orgId + status='no_reply'` so that
   * concurrent calls, customer replies, or status transitions that already
   * moved the row away from no_reply will cause zero rows affected.
   *
   * Returns the updated row, or null if no row matched.
   */
  async markMerchantNoReplyCanceled(
    verificationId: string,
    orgId: string,
    canceledAt: string,
    operation?: CommerceOutcomeOperationResult,
  ) {
    const now = new Date().toISOString();
    const [result] = await this.db
      .update(verifications)
      .set({
        status: 'canceled',
        canceledAt,
        merchantCanceledAt: canceledAt,
        cancellationSource: 'merchant_no_reply',
        ...(operation
          ? {
              metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ commerceCancellation: operation })}::jsonb`,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(verifications.id, verificationId),
          eq(verifications.orgId, orgId),
          sql`${verifications.status} = 'no_reply'`,
        ),
      )
      .returning();
    return result ?? null;
  }

  /**
   * Atomically record a merchant's manual confirmation.
   *
   * Guards on `id + orgId + status` so a customer reply or a cancellation that
   * lands first wins and this affects zero rows. Delivered/read are left as
   * WhatsApp reported them: the merchant confirming is not a read receipt.
   *
   * Returns the updated row, or null if no row matched.
   */
  async markMerchantConfirmed(
    verificationId: string,
    orgId: string,
    confirmedBy: string,
  ) {
    const now = new Date().toISOString();
    const [result] = await this.db
      .update(verifications)
      .set({
        status: 'confirmed',
        confirmedAt: now,
        confirmationSource: 'merchant_manual',
        metadata: sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify({ manualConfirmedBy: confirmedBy })}::jsonb`,
        updatedAt: now,
      })
      .where(
        and(
          eq(verifications.id, verificationId),
          eq(verifications.orgId, orgId),
          inArray(verifications.status, MANUALLY_CONFIRMABLE_STATUSES),
        ),
      )
      .returning();
    return result ?? null;
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
   *
   * When the payload changes `status`, the terminal guard applies: a customer
   * who already confirmed or canceled cannot be walked backwards by a late
   * send-failure projection. Metadata-only updates are unaffected.
   */
  async updateByIdForOrg(
    verificationId: string,
    orgId: string,
    updates: Partial<typeof verifications.$inferInsert>,
  ) {
    const conditions = [
      eq(verifications.id, verificationId),
      eq(verifications.orgId, orgId),
    ];
    if (updates.status !== undefined) {
      conditions.push(notInArray(verifications.status, TERMINAL_STATUSES));
    }

    const [result] = await this.db
      .update(verifications)
      .set({
        ...updates,
        updatedAt: new Date().toISOString(),
      })
      .where(and(...conditions))
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
    failureInfo?: { code?: number | string; title?: string },
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

      case 'failed': {
        // Mirrors the reason the prepaid-credit projection already writes
        // (verification-message-dispatches.repository.ts) so both accounting
        // modes land on the same, already-retryable taxonomy entry instead of
        // leaving `metadata.reason` NULL for WhatsApp-reported delivery
        // failures. The provider's own code/title ride along for triage.
        const metadataPatch: Record<string, unknown> = {
          reason: 'provider_delivery_failed',
        };
        if (failureInfo?.code !== undefined) {
          metadataPatch.providerErrorCode = failureInfo.code;
        }
        if (failureInfo?.title) {
          metadataPatch.providerErrorTitle = failureInfo.title;
        }
        payload.metadata = sql`COALESCE(${verifications.metadata}, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb`;
        break;
      }

      default:
        break;
    }

    return payload;
  }

  /**
   * Imported orders that are held, as list rows.
   *
   * A held order has no verification yet -- commit deliberately creates none --
   * so it is invisible to `findByOrg`. The dashboard still has to show it,
   * because the merchant has orders waiting on a decision only they can make.
   * Kept as its own query rather than a UNION inside `findByOrg` so the
   * verification list the rest of E04 is built on stays exactly as it was; the
   * service merges the two sorted streams.
   */
  async findHeldByOrg(
    orgId: string,
    period?: { startAt: string; endAt: string },
    opts?: {
      cursor?: { createdAt: string; id: string };
      limit?: number;
      importBatchId?: string;
    },
  ): Promise<HeldOrderListRow[]> {
    const conditions = this.buildHeldListConditions(
      orgId,
      period,
      opts?.importBatchId,
    );
    if (opts?.cursor) {
      conditions.push(
        or(
          lt(orders.createdAt, opts.cursor.createdAt),
          and(
            sql`${orders.createdAt} = ${opts.cursor.createdAt}`,
            lt(orders.id, opts.cursor.id),
          ),
        ),
      );
    }
    return this.db
      .select({
        id: orders.id,
        orderId: orders.id,
        createdAt: orders.createdAt,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        totalPrice: orders.totalPrice,
        currency: orders.currency,
        isTest: orders.isTest,
        orgId: orders.orgId,
        integrationId: orders.integrationId,
        externalOrderId: orders.externalOrderId,
      })
      .from(orders)
      .innerJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(opts?.limit ?? 50);
  }

  /** The held rows a `findHeldByOrg` call would return, ignoring the cursor. */
  async countHeldByOrg(
    orgId: string,
    period?: { startAt: string; endAt: string },
    importBatchId?: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(orders)
      .innerJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(
        and(...this.buildHeldListConditions(orgId, period, importBatchId)),
      );
    return row?.value ?? 0;
  }

  /**
   * Org + date-range + batch filter shared by the held list and count queries,
   * for the same reason `buildOrgListConditions` is shared.
   */
  private buildHeldListConditions(
    orgId: string,
    period?: { startAt: string; endAt: string },
    importBatchId?: string,
  ) {
    return [
      eq(orders.orgId, orgId),
      eq(webhookEvents.holdState, 'held'),
      // A released order has a verification and belongs to the ordinary list;
      // this guard also keeps a row from appearing twice during the handover.
      sql`NOT EXISTS (SELECT 1 FROM ${verifications} v WHERE v.order_id = ${orders.id})`,
      period ? gte(orders.createdAt, period.startAt) : undefined,
      period ? lt(orders.createdAt, period.endAt) : undefined,
      importBatchId ? importBatchRowExists(orgId, importBatchId) : undefined,
    ].filter(Boolean);
  }
}

/** Tab and search narrowing for the confirmations list. */
export interface VerificationListRefinement {
  tab?: VerificationListTab;
  /** Digits only; matched as an order-number prefix or a phone substring. */
  searchDigits?: string;
  /** Required for the needs-action tab and for each row's `actionReason`. */
  needsAction?: NeedsActionContext;
}

/** A row of the dashboard's needs-action card. */
export interface NeedsActionRow {
  id: string;
  orderId: string;
  status: VerificationStatus;
  actionReason: NeedsActionReason | null;
  metadata: unknown;
  createdAt: string | null;
  lastSentAt: string | null;
  readAt: string | null;
  followUpSentAt: string | null;
  noReplyAt: string | null;
  order: {
    orgId: string;
    integrationId: string;
    externalOrderId: string;
    orderNumber: string | null;
    customerName: string | null;
    customerPhone: string;
    totalPrice: string | null;
    currency: string | null;
    isTest: boolean;
  };
}

function tabCondition(
  tab: VerificationListTab,
  refinement: VerificationListRefinement,
) {
  switch (tab) {
    case 'needs_action':
      if (!refinement.needsAction) {
        throw new Error('needs_action tab requires a needs-action context');
      }
      return sql`${needsActionReasonSql(refinement.needsAction)} IS NOT NULL`;
    case 'confirmed':
    case 'canceled':
    case 'failed':
      return eq(verifications.status, tab);
    case 'all':
      return undefined;
  }
}

/**
 * Order number (prefix) or phone (any run of digits), within one org.
 *
 * The digits are bound as a parameter; LIKE wildcards cannot reach the query
 * because the caller has already reduced the input to 0-9.
 */
function orderSearchCondition(orgId: string, digits: string) {
  return sql`EXISTS (
    SELECT 1 FROM ${orders} o
    WHERE o.id = ${verifications.orderId}
      AND o.org_id = ${orgId}
      AND (
        o.order_number LIKE ${`${digits}%`}
        OR regexp_replace(o.customer_phone, '\\D', '', 'g') LIKE ${`%${digits}%`}
      )
  )`;
}

/** A held, imported order projected as a verification-list row. */
export interface HeldOrderListRow {
  id: string;
  orderId: string;
  createdAt: string | null;
  orderNumber: string | null;
  customerName: string | null;
  customerPhone: string;
  totalPrice: string | null;
  currency: string | null;
  isTest: boolean;
  orgId: string;
  integrationId: string;
  externalOrderId: string;
}

/**
 * Restricts a list to the orders one import batch created.
 *
 * `order_import_rows` is the authoritative link (an order carries the batch id
 * only in `raw_payload`), and it is scoped by `org_id` in its own right, so a
 * batch id from another tenant matches nothing rather than leaking a row.
 */
function importBatchRowExists(
  orgId: string,
  batchId: string,
  orderIdColumn: typeof orders.id | typeof verifications.orderId = orders.id,
) {
  return sql`EXISTS (
    SELECT 1 FROM ${orderImportRows} r
    WHERE r.order_id = ${orderIdColumn}
      AND r.batch_id = ${batchId}
      AND r.org_id = ${orgId}
  )`;
}
