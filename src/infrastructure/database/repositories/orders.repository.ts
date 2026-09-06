import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { eq, and, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import {
  integrations,
  orders,
  verificationMessageDispatches,
  verifications,
  webhookEvents,
} from '../schema';
import {
  BLOCKED_EVENT_REASONS as blockedEventReasons,
  RETRYABLE_VERIFICATION_REASONS as retryableVerificationReasons,
} from '../../../shared/verification/verification-lifecycle';

const dispatchCount = sql<number>`(
  SELECT count(*)::int
  FROM ${verificationMessageDispatches}
  WHERE ${verificationMessageDispatches.verificationId} = ${verifications.id}
)`;

const hasUnknownDispatch = sql<boolean>`EXISTS (
  SELECT 1
  FROM ${verificationMessageDispatches}
  WHERE ${verificationMessageDispatches.verificationId} = ${verifications.id}
    AND ${verificationMessageDispatches.state} = 'outcome_unknown'
)`;

const verificationReason = sql<
  string | null
>`${verifications.metadata}->>'reason'`;

const dashboardLifecycleStatus = sql<string>`CASE
  WHEN ${verifications.id} IS NOT NULL THEN CASE
    -- A customer reply is the final word. It outranks an unresolved dispatch
    -- so a confirmed order never surfaces as 'review_required'.
    WHEN ${verifications.status} IN ('confirmed', 'canceled')
      THEN ${verifications.status}::text
    WHEN ${hasUnknownDispatch}
      OR (${dispatchCount} = 0 AND ${verificationReason} = 'provider_outcome_unknown')
      THEN 'review_required'
    WHEN ${verifications.status} = 'failed'
      AND ${verificationReason} IN (${sql.join(
        retryableVerificationReasons.map((reason) => sql`${reason}`),
        sql`, `,
      )})
      THEN 'blocked'
    ELSE COALESCE(${verifications.status}::text, 'pending')
  END
  WHEN ${webhookEvents.id} IS NULL OR ${webhookEvents.status} = 'pending'
    THEN 'accepted'
  WHEN ${webhookEvents.status} = 'processing' THEN 'processing'
  WHEN ${webhookEvents.lastError} IN ('non_cod_payment_method', 'missing_payment_signal')
    THEN 'ineligible'
  WHEN ${webhookEvents.lastError} IN (${sql.join(
    blockedEventReasons.map((reason) => sql`${reason}`),
    sql`, `,
  )})
    THEN 'blocked'
  ELSE 'failed'
END`;

const dashboardLifecycleReason = sql<string | null>`CASE
  WHEN ${verifications.id} IS NOT NULL THEN CASE
    -- A resolved verification has no outstanding reason to report.
    WHEN ${verifications.status} IN ('confirmed', 'canceled') THEN NULL
    WHEN ${hasUnknownDispatch}
      OR (${dispatchCount} = 0 AND ${verificationReason} = 'provider_outcome_unknown')
      THEN 'provider_outcome_unknown'
    WHEN ${dispatchCount} > 0 AND ${verificationReason} = 'provider_outcome_unknown'
      THEN NULL
    ELSE ${verificationReason}
  END
  ELSE ${webhookEvents.lastError}
END`;

const dashboardLifecycleRetryable = sql<boolean>`CASE
  WHEN ${verifications.id} IS NOT NULL THEN
    ${verifications.status} = 'failed'
    AND NOT ${hasUnknownDispatch}
    AND ${verificationReason} IN (${sql.join(
      retryableVerificationReasons.map((reason) => sql`${reason}`),
      sql`, `,
    )})
  WHEN ${webhookEvents.id} IS NULL OR ${webhookEvents.status} IN ('pending', 'processing')
    THEN false
  WHEN ${webhookEvents.lastError} IN (${sql.join(
    blockedEventReasons.map((reason) => sql`${reason}`),
    sql`, `,
  )}) THEN true
  ELSE COALESCE(${webhookEvents.lastError} LIKE 'dispatch_terminal:%', false)
END`;

export interface DashboardOrderQuery {
  startAt: string;
  endAt: string;
  statuses?: string[];
  cursor?: { createdAt: string; id: string };
  limit?: number;
}

@Injectable()
export class OrdersRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async create(data: typeof orders.$inferInsert) {
    const [result] = await this.db.insert(orders).values(data).returning();
    return result;
  }

  async findById(orderId: string) {
    return await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      with: {
        integration: true,
        verifications: { with: { messageDispatches: true } },
        webhookEvents: true,
      },
    });
  }

  async findBySourceExternalId(source: {
    orgId: string;
    integrationId: string;
    externalOrderId: string;
  }) {
    return await this.db.query.orders.findFirst({
      where: and(
        eq(orders.orgId, source.orgId),
        eq(orders.integrationId, source.integrationId),
        eq(orders.externalOrderId, source.externalOrderId),
      ),
    });
  }

  async findForOutcomeDispatch(source: {
    orgId: string;
    integrationId: string;
    externalOrderId: string;
  }) {
    return await this.db.query.orders.findFirst({
      where: and(
        eq(orders.orgId, source.orgId),
        eq(orders.integrationId, source.integrationId),
        eq(orders.externalOrderId, source.externalOrderId),
      ),
      with: {
        integration: true,
      },
    });
  }

  async findByOrg(
    orgId: string,
    opts?: { cursor?: { createdAt: string; id: string }; limit?: number },
  ): Promise<
    Array<
      typeof orders.$inferSelect & {
        verifications: Array<
          typeof schema.verifications.$inferSelect & {
            messageDispatches: Array<
              typeof schema.verificationMessageDispatches.$inferSelect
            >;
          }
        >;
        webhookEvents: Array<typeof schema.webhookEvents.$inferSelect>;
      }
    >
  > {
    const limit = opts?.limit ?? 50;

    const conditions = [eq(orders.orgId, orgId)];

    if (opts?.cursor) {
      conditions.push(
        or(
          lt(orders.createdAt, opts.cursor.createdAt),
          and(
            sql`${orders.createdAt} = ${opts.cursor.createdAt}`,
            lt(orders.id, opts.cursor.id),
          ),
        )!,
      );
    }

    return await this.db.query.orders.findMany({
      where: and(...conditions),
      with: {
        verifications: { with: { messageDispatches: true } },
        webhookEvents: true,
      },
      orderBy: (orders, { desc }) => [desc(orders.createdAt), desc(orders.id)],
      limit,
    });
  }

  /**
   * Load a single order with the same lifecycle projection the dashboard uses.
   *
   * The retry endpoint reads this instead of recomputing the lifecycle in
   * TypeScript, so a merchant can never be offered a retry the dashboard does
   * not show — or refused one it does.
   */
  async findDashboardOrderById(orderId: string, orgId: string) {
    const [row] = await this.db
      .select({
        id: orders.id,
        orgId: orders.orgId,
        integrationId: orders.integrationId,
        externalOrderId: orders.externalOrderId,
        isTest: orders.isTest,
        platformType: integrations.platformType,
        verificationId: verifications.id,
        verificationStatus: verifications.status,
        lifecycleStatus: dashboardLifecycleStatus,
        lifecycleReason: dashboardLifecycleReason,
        lifecycleRetryable: dashboardLifecycleRetryable,
      })
      .from(orders)
      .innerJoin(integrations, eq(integrations.id, orders.integrationId))
      .leftJoin(verifications, eq(verifications.orderId, orders.id))
      .leftJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(and(eq(orders.id, orderId), eq(orders.orgId, orgId)))
      .limit(1);
    return row;
  }

  private dashboardConditions(orgId: string, query: DashboardOrderQuery) {
    return [
      eq(orders.orgId, orgId),
      gte(orders.createdAt, query.startAt),
      lt(orders.createdAt, query.endAt),
      query.statuses?.length
        ? inArray(dashboardLifecycleStatus, query.statuses)
        : undefined,
    ].filter(Boolean);
  }

  async findDashboardByOrg(orgId: string, query: DashboardOrderQuery) {
    const conditions = this.dashboardConditions(orgId, query);
    if (query.cursor) {
      conditions.push(
        or(
          lt(orders.createdAt, query.cursor.createdAt),
          and(
            sql`${orders.createdAt} = ${query.cursor.createdAt}`,
            lt(orders.id, query.cursor.id),
          ),
        ),
      );
    }

    return await this.db
      .select({
        id: orders.id,
        orgId: orders.orgId,
        integrationId: orders.integrationId,
        externalOrderId: orders.externalOrderId,
        orderNumber: orders.orderNumber,
        customerPhone: orders.customerPhone,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        totalPrice: orders.totalPrice,
        currency: orders.currency,
        isTest: orders.isTest,
        createdAt: orders.createdAt,
        platformType: integrations.platformType,
        verificationId: verifications.id,
        verificationStatus: verifications.status,
        verificationMetadata: verifications.metadata,
        lastSentAt: verifications.lastSentAt,
        deliveredAt: verifications.deliveredAt,
        readAt: verifications.readAt,
        confirmedAt: verifications.confirmedAt,
        canceledAt: verifications.canceledAt,
        expiredAt: verifications.expiredAt,
        noReplyAt: verifications.noReplyAt,
        followUpAttempts: verifications.followUpAttempts,
        followUpSentAt: verifications.followUpSentAt,
        lifecycleStatus: dashboardLifecycleStatus,
        lifecycleReason: dashboardLifecycleReason,
        lifecycleRetryable: dashboardLifecycleRetryable,
      })
      .from(orders)
      .innerJoin(integrations, eq(integrations.id, orders.integrationId))
      .leftJoin(verifications, eq(verifications.orderId, orders.id))
      .leftJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(and(...conditions))
      .orderBy(sql`${orders.createdAt} DESC`, sql`${orders.id} DESC`)
      .limit(query.limit ?? 50);
  }

  async countDashboardByOrg(
    orgId: string,
    query: DashboardOrderQuery,
  ): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .innerJoin(integrations, eq(integrations.id, orders.integrationId))
      .leftJoin(verifications, eq(verifications.orderId, orders.id))
      .leftJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(and(...this.dashboardConditions(orgId, query)));
    return row?.count ?? 0;
  }

  async getDashboardStatsByOrg(
    orgId: string,
    query: Pick<DashboardOrderQuery, 'startAt' | 'endAt'>,
  ) {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        inProgress: sql<number>`count(*) FILTER (WHERE ${dashboardLifecycleStatus} IN ('accepted', 'processing', 'pending', 'sent', 'delivered', 'read'))::int`,
        needsAttention: sql<number>`count(*) FILTER (WHERE ${dashboardLifecycleStatus} IN ('ineligible', 'blocked', 'failed', 'expired', 'no_reply', 'review_required'))::int`,
        confirmedOrders: sql<number>`count(*) FILTER (WHERE ${dashboardLifecycleStatus} = 'confirmed')::int`,
        canceledOrders: sql<number>`count(*) FILTER (WHERE ${dashboardLifecycleStatus} = 'canceled')::int`,
        pending: sql<number>`count(*) FILTER (WHERE ${verifications.status} = 'pending')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${verifications.status} = 'failed')::int`,
        awaitingReply: sql<number>`count(*) FILTER (WHERE ${verifications.status} IN ('sent', 'delivered', 'read', 'no_reply'))::int`,
        sent: sql<number>`count(${verifications.lastSentAt})::int`,
        delivered: sql<number>`count(${verifications.deliveredAt})::int`,
        read: sql<number>`count(${verifications.readAt})::int`,
        confirmed: sql<number>`count(${verifications.confirmedAt})::int`,
        canceled: sql<number>`count(${verifications.canceledAt})::int`,
        customerCanceled: sql<number>`count(*) FILTER (WHERE ${verifications.canceledAt} IS NOT NULL AND (${verifications.cancellationSource} IS NULL OR ${verifications.cancellationSource} = 'customer'))::int`,
        followUpsSent: sql<number>`COALESCE(sum(${verifications.followUpAttempts}), 0)::int`,
      })
      .from(orders)
      .innerJoin(integrations, eq(integrations.id, orders.integrationId))
      .leftJoin(verifications, eq(verifications.orderId, orders.id))
      .leftJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(and(...this.dashboardConditions(orgId, query)));

    return {
      total: row?.total ?? 0,
      inProgress: row?.inProgress ?? 0,
      needsAttention: row?.needsAttention ?? 0,
      confirmedOrders: row?.confirmedOrders ?? 0,
      canceledOrders: row?.canceledOrders ?? 0,
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

  async findByOrgAndPhone(
    orgId: string,
    customerPhone: string,
  ): Promise<
    Array<
      typeof orders.$inferSelect & {
        verifications: Array<typeof schema.verifications.$inferSelect>;
      }
    >
  > {
    return await this.db.query.orders.findMany({
      where: and(
        eq(orders.orgId, orgId),
        eq(orders.customerPhone, customerPhone),
      ),
      with: {
        verifications: true,
      },
      orderBy: (orders, { desc }) => [desc(orders.createdAt)],
    });
  }

  async redactCustomerByOrderIds(orderIds: string[]): Promise<number> {
    if (orderIds.length === 0) {
      return 0;
    }

    const results = await this.db
      .update(orders)
      .set({
        customerPhone: '',
        customerName: null,
        customerEmail: null,
        rawPayload: {},
        updatedAt: new Date().toISOString(),
      })
      .where(inArray(orders.id, orderIds))
      .returning({ id: orders.id });

    return results.length;
  }

  async deleteByOrgId(orgId: string): Promise<number> {
    const results = await this.db
      .delete(orders)
      .where(eq(orders.orgId, orgId))
      .returning({ id: orders.id });

    return results.length;
  }
}
