import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { eq, and, inArray, lt, or, sql } from 'drizzle-orm';
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

const retryGuardStatus = sql<string>`CASE
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

const retryGuardReason = sql<string | null>`CASE
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

const retryGuardRetryable = sql<boolean>`CASE
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
   * Load a single order together with the state the retry endpoint guards on.
   *
   * These states (`accepted`, `processing`, `review_required`, `blocked`,
   * `ineligible`) are deliberately *not* part of the merchant-facing status
   * vocabulary — the dashboard speaks only the nine values the
   * `verification_status` enum can hold. They exist here because retry safety
   * needs finer distinctions than the UI does: an order whose dispatch outcome
   * is unknown must not be re-sent, and one still queued must not be treated as
   * a failure. Computed in SQL so the guard cannot drift from the data.
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
        retryGuardStatus,
        retryGuardReason,
        retryGuardRetryable,
      })
      .from(orders)
      .innerJoin(integrations, eq(integrations.id, orders.integrationId))
      .leftJoin(verifications, eq(verifications.orderId, orders.id))
      .leftJoin(webhookEvents, eq(webhookEvents.orderId, orders.id))
      .where(and(eq(orders.id, orderId), eq(orders.orgId, orgId)))
      .limit(1);
    return row;
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
