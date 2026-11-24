import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  integrations,
  orders,
  verificationShippingNotifications,
  verifications,
} from '../schema';
import type { ShippingStage } from '../../../shared/shipping/shipping-notification.types';

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
