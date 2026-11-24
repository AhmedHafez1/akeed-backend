import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  integrations,
  orders,
  verificationShippingNotifications,
  verifications,
} from '../schema';
import {
  DELIVERY_REQUEST_REPLIES,
  UNREACHABLE_SHIPPING_REASONS,
  type ShippingCustomerReply,
  type ShippingFailureReason,
  type ShippingStage,
} from '../../../shared/shipping/shipping-notification.types';

export type ShippingNotificationRow =
  typeof verificationShippingNotifications.$inferSelect;
export type ShippingNotificationInsert =
  typeof verificationShippingNotifications.$inferInsert;

/** What the shipping core needs to decide on one store order event. */
export interface ShippingOrderContext {
  verificationId: string;
  verificationStatus: string;
  verificationCanceledAt: string | null;
  merchantCanceledAt: string | null;
  orderIsTest: boolean;
  orderCreatedAt: string | null;
  shippingNotificationsEnabled: boolean;
  shippingFulfillmentTriggerEnabled: boolean;
  shippingTags: string[];
}

/** The record and what the send job re-checks before sending. */
export interface ShippingSendContext {
  notification: ShippingNotificationRow;
  verificationStatus: string;
  verificationCanceledAt: string | null;
  merchantCanceledAt: string | null;
  orderIsTest: boolean;
  orderCreatedAt: string | null;
  customerPhone: string | null;
  shippingNotificationsEnabled: boolean;
}

@Injectable()
export class ShippingNotificationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * The order, its verification and the store's shipping settings in one
   * query. The order is found by its unique (integration, external id) key,
   * and every table is scoped to the merchant. Null when Akeed has no
   * verification for that order.
   */
  async findShippingContext(source: {
    orgId: string;
    integrationId: string;
    externalOrderId: string;
  }): Promise<ShippingOrderContext | null> {
    const rows = await this.db
      .select({
        verificationId: verifications.id,
        verificationStatus: verifications.status,
        verificationCanceledAt: verifications.canceledAt,
        merchantCanceledAt: verifications.merchantCanceledAt,
        orderIsTest: orders.isTest,
        orderCreatedAt: orders.createdAt,
        shippingNotificationsEnabled: integrations.shippingNotificationsEnabled,
        shippingFulfillmentTriggerEnabled:
          integrations.shippingFulfillmentTriggerEnabled,
        shippingTags: integrations.shippingTags,
      })
      .from(orders)
      .innerJoin(
        integrations,
        and(
          eq(integrations.id, orders.integrationId),
          eq(integrations.orgId, orders.orgId),
        ),
      )
      .innerJoin(
        verifications,
        and(
          eq(verifications.orderId, orders.id),
          eq(verifications.orgId, orders.orgId),
        ),
      )
      .where(
        and(
          eq(orders.orgId, source.orgId),
          eq(orders.integrationId, source.integrationId),
          eq(orders.externalOrderId, source.externalOrderId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      verificationStatus: String(row.verificationStatus),
      orderCreatedAt: row.orderCreatedAt ?? null,
      shippingTags: row.shippingTags ?? [],
    };
  }

  /**
   * Records a shipping notification once per verification and stage. Null
   * when one already exists: the earlier row stands.
   */
  async insertIfNew(
    row: ShippingNotificationInsert,
  ): Promise<ShippingNotificationRow | null> {
    const inserted = await this.db
      .insert(verificationShippingNotifications)
      .values(row)
      .onConflictDoNothing({
        target: [
          verificationShippingNotifications.verificationId,
          verificationShippingNotifications.stage,
        ],
      })
      .returning();
    return inserted[0] ?? null;
  }

  /**
   * What the send job re-checks before the Shipped message goes out: the
   * record, the order's state and the store's switch, scoped to the merchant.
   */
  async findSendContext(params: {
    orgId: string;
    shippingNotificationId: string;
  }): Promise<ShippingSendContext | null> {
    const rows = await this.db
      .select({
        notification: verificationShippingNotifications,
        verificationStatus: verifications.status,
        verificationCanceledAt: verifications.canceledAt,
        merchantCanceledAt: verifications.merchantCanceledAt,
        orderIsTest: orders.isTest,
        orderCreatedAt: orders.createdAt,
        customerPhone: orders.customerPhone,
        shippingNotificationsEnabled: integrations.shippingNotificationsEnabled,
      })
      .from(verificationShippingNotifications)
      .innerJoin(
        verifications,
        and(
          eq(
            verifications.id,
            verificationShippingNotifications.verificationId,
          ),
          eq(verifications.orgId, verificationShippingNotifications.orgId),
        ),
      )
      .innerJoin(
        orders,
        and(
          eq(orders.id, verifications.orderId),
          eq(orders.orgId, verifications.orgId),
        ),
      )
      .innerJoin(
        integrations,
        and(
          eq(integrations.id, orders.integrationId),
          eq(integrations.orgId, orders.orgId),
        ),
      )
      .where(
        and(
          eq(verificationShippingNotifications.orgId, params.orgId),
          eq(
            verificationShippingNotifications.id,
            params.shippingNotificationId,
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      verificationStatus: String(row.verificationStatus),
      orderCreatedAt: row.orderCreatedAt ?? null,
      customerPhone: row.customerPhone ?? null,
    };
  }

  /**
   * Fails a record that is still pending: the message was never sent. A
   * record already sent, delivered, read or failed is left as it is.
   */
  async markFailed(params: {
    orgId: string;
    shippingNotificationId: string;
    reason: ShippingFailureReason;
    at: string;
  }): Promise<boolean> {
    const rows = await this.db
      .update(verificationShippingNotifications)
      .set({
        status: 'failed',
        reasonCode: params.reason,
        updatedAt: params.at,
      })
      .where(
        and(
          eq(verificationShippingNotifications.orgId, params.orgId),
          eq(
            verificationShippingNotifications.id,
            params.shippingNotificationId,
          ),
          eq(verificationShippingNotifications.status, 'pending'),
        ),
      )
      .returning({ id: verificationShippingNotifications.id });
    return rows.length > 0;
  }

  /**
   * Keeps the customer's first tap on the Shipped message. A later tap, or a
   * replay of the same one, changes nothing; the webhook's message history
   * still has it. Only a record whose message went out can be answered.
   */
  async recordCustomerReply(params: {
    orgId: string;
    verificationId: string;
    reply: ShippingCustomerReply;
    at: string;
  }): Promise<ShippingNotificationRow | null> {
    const rows = await this.db
      .update(verificationShippingNotifications)
      .set({
        customerReply: params.reply,
        customerRepliedAt: params.at,
        updatedAt: params.at,
      })
      .where(
        and(
          eq(verificationShippingNotifications.orgId, params.orgId),
          eq(
            verificationShippingNotifications.verificationId,
            params.verificationId,
          ),
          eq(verificationShippingNotifications.stage, 'shipped'),
          isNull(verificationShippingNotifications.customerReply),
          isNotNull(verificationShippingNotifications.dispatchId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Marks what the record asks of the merchant as dealt with: a reschedule or
   * address request, or a message that could not reach the customer. Null
   * when nothing is open (none, already resolved, or the tap was I'll be home).
   */
  async resolveNeedsAction(params: {
    orgId: string;
    verificationId: string;
    userId: string;
    at: string;
  }): Promise<ShippingNotificationRow | null> {
    const rows = await this.db
      .update(verificationShippingNotifications)
      .set({
        needsActionResolvedAt: params.at,
        needsActionResolvedBy: params.userId,
        updatedAt: params.at,
      })
      .where(
        and(
          eq(verificationShippingNotifications.orgId, params.orgId),
          eq(
            verificationShippingNotifications.verificationId,
            params.verificationId,
          ),
          eq(verificationShippingNotifications.stage, 'shipped'),
          isNull(verificationShippingNotifications.needsActionResolvedAt),
          or(
            inArray(verificationShippingNotifications.customerReply, [
              ...DELIVERY_REQUEST_REPLIES,
            ]),
            and(
              eq(verificationShippingNotifications.status, 'failed'),
              inArray(verificationShippingNotifications.reasonCode, [
                ...UNREACHABLE_SHIPPING_REASONS,
              ]),
            ),
          ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** The Shipped records of one page of verifications, scoped to the merchant. */
  async findForVerifications(
    orgId: string,
    verificationIds: readonly string[],
  ): Promise<ShippingNotificationRow[]> {
    if (!verificationIds.length) return [];
    return this.db
      .select()
      .from(verificationShippingNotifications)
      .where(
        and(
          eq(verificationShippingNotifications.orgId, orgId),
          inArray(verificationShippingNotifications.verificationId, [
            ...verificationIds,
          ]),
          eq(verificationShippingNotifications.stage, 'shipped'),
        ),
      );
  }

  async findByVerification(params: {
    orgId: string;
    verificationId: string;
    stage: ShippingStage;
  }): Promise<ShippingNotificationRow | null> {
    const rows = await this.db
      .select()
      .from(verificationShippingNotifications)
      .where(
        and(
          eq(verificationShippingNotifications.orgId, params.orgId),
          eq(
            verificationShippingNotifications.verificationId,
            params.verificationId,
          ),
          eq(verificationShippingNotifications.stage, params.stage),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
