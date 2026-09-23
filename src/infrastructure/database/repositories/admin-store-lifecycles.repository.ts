import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { adminStoreLifecycles, orders, verifications } from '../schema';
import { ProductEventsRepository } from './product-events.repository';
import type {
  ProductEventName,
  ProductEventProps,
} from '../../../shared/analytics/product-events';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';

export type AdminLifecycleMilestone =
  | 'onboardingStartedAt'
  | 'onboardingCompletedAt'
  | 'planSelectedAt'
  | 'testRequestedAt'
  | 'testDeliveredAt'
  | 'firstEligibleOrderAt'
  | 'firstMessageDeliveredAt'
  | 'firstCustomerResponseAt'
  | 'firstResolvedAt'
  | 'paidSubscriptionActivatedAt'
  | 'setupCompletedAt'
  | 'testSentAt'
  | 'testConfirmedAt'
  | 'testSkippedAt'
  | 'firstRealConfirmedAt'
  | 'credits80At';

@Injectable()
export class AdminStoreLifecyclesRepository {
  private readonly logger = new Logger(AdminStoreLifecyclesRepository.name);

  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
    @Optional()
    private readonly productEvents?: ProductEventsRepository,
  ) {}

  async startInstallation(params: {
    orgId: string;
    integrationId: string;
    installedAt?: string;
    provenance?: Record<string, unknown>;
  }) {
    const current = await this.findCurrent(params.integrationId);
    if (current) return current;

    const [created] = await this.db
      .insert(adminStoreLifecycles)
      .values({
        orgId: params.orgId,
        integrationId: params.integrationId,
        installedAt: params.installedAt ?? new Date().toISOString(),
        provenance: params.provenance ?? { installation: 'captured_exact' },
      })
      .returning();

    return created;
  }

  async findCurrent(integrationId: string) {
    return this.db.query.adminStoreLifecycles.findFirst({
      where: and(
        eq(adminStoreLifecycles.integrationId, integrationId),
        isNull(adminStoreLifecycles.uninstalledAt),
      ),
      orderBy: (lifecycle, { desc }) => [desc(lifecycle.installedAt)],
    });
  }

  async markMilestone(
    integrationId: string,
    milestone: AdminLifecycleMilestone,
    occurredAt = new Date().toISOString(),
    provenance?: Record<string, unknown>,
  ): Promise<void> {
    const column = adminStoreLifecycles[milestone];
    const updates: Record<string, unknown> = {
      [milestone]: sql`COALESCE(${column}, ${occurredAt})`,
      updatedAt: new Date().toISOString(),
    };

    if (provenance) {
      updates.provenance = sql`COALESCE(${adminStoreLifecycles.provenance}, '{}'::jsonb) || ${JSON.stringify(provenance)}::jsonb`;
    }

    await this.db
      .update(adminStoreLifecycles)
      .set(updates)
      .where(
        and(
          eq(adminStoreLifecycles.integrationId, integrationId),
          isNull(adminStoreLifecycles.uninstalledAt),
        ),
      );
  }

  /**
   * Sets a milestone only if it is still empty and, when that first hit
   * happens, records the matching product event. Returns whether this call was
   * the first hit, so repeats (a second test confirmation, a later delivery)
   * never produce duplicate funnel events.
   */
  async reachMilestone(
    integrationId: string,
    milestone: AdminLifecycleMilestone,
    event: ProductEventName,
    options: {
      occurredAt?: string;
      provenance?: Record<string, unknown>;
      props?: ProductEventProps;
    } = {},
  ): Promise<boolean> {
    const occurredAt = options.occurredAt ?? new Date().toISOString();
    const column = adminStoreLifecycles[milestone];
    const updates: Record<string, unknown> = {
      [milestone]: occurredAt,
      updatedAt: new Date().toISOString(),
    };
    if (options.provenance) {
      updates.provenance = sql`COALESCE(${adminStoreLifecycles.provenance}, '{}'::jsonb) || ${JSON.stringify(options.provenance)}::jsonb`;
    }

    const reached = await this.db
      .update(adminStoreLifecycles)
      .set(updates)
      .where(
        and(
          eq(adminStoreLifecycles.integrationId, integrationId),
          isNull(adminStoreLifecycles.uninstalledAt),
          isNull(column),
        ),
      )
      .returning({ id: adminStoreLifecycles.id });

    if (reached.length === 0) return false;
    await this.recordEvent(integrationId, event, options.props, occurredAt);
    return true;
  }

  /**
   * Funnel events are observability, not business state: a failed insert is
   * logged and swallowed so it can never break the webhook or send path that
   * produced it.
   */
  async recordEvent(
    integrationId: string,
    name: ProductEventName,
    props?: ProductEventProps,
    occurredAt?: string,
  ): Promise<void> {
    if (!this.productEvents) return;
    try {
      await this.productEvents.insert({
        integrationId,
        name,
        props,
        occurredAt,
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog(AdminStoreLifecyclesRepository.name, {
          action: 'product-event-record',
          outcome: 'failure',
          integrationId,
          event: name,
          ...normalizeError(error),
        }),
      );
    }
  }

  async markUninstalled(
    integrationId: string,
    occurredAt = new Date().toISOString(),
  ): Promise<void> {
    await this.db
      .update(adminStoreLifecycles)
      .set({
        uninstalledAt: occurredAt,
        updatedAt: occurredAt,
        provenance: sql`COALESCE(${adminStoreLifecycles.provenance}, '{}'::jsonb) || '{"uninstall":"captured_exact"}'::jsonb`,
      })
      .where(
        and(
          eq(adminStoreLifecycles.integrationId, integrationId),
          isNull(adminStoreLifecycles.uninstalledAt),
        ),
      );
  }

  async recordMessageStatus(params: {
    verificationId: string;
    status: 'delivered' | 'read' | 'confirmed' | 'canceled';
    occurredAt?: string;
  }): Promise<void> {
    const occurredAt = params.occurredAt ?? new Date().toISOString();
    const verification = await this.db
      .select({
        integrationId: orders.integrationId,
        isTest: orders.isTest,
      })
      .from(verifications)
      .innerJoin(orders, eq(verifications.orderId, orders.id))
      .where(eq(verifications.id, params.verificationId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!verification?.integrationId) return;

    if (verification.isTest) {
      if (params.status === 'delivered' || params.status === 'read') {
        await this.markMilestone(
          verification.integrationId,
          'testDeliveredAt',
          occurredAt,
          { test_delivery: 'captured_exact' },
        );
      }
      if (params.status === 'confirmed') {
        await this.reachMilestone(
          verification.integrationId,
          'testConfirmedAt',
          'test_confirmed',
          { occurredAt, provenance: { test_confirmed: 'captured_exact' } },
        );
      }
      return;
    }

    if (
      params.status === 'delivered' ||
      params.status === 'read' ||
      params.status === 'confirmed' ||
      params.status === 'canceled'
    ) {
      await this.reachMilestone(
        verification.integrationId,
        'firstMessageDeliveredAt',
        'first_order_sent',
        {
          occurredAt,
          provenance: { first_message_delivery: 'captured_exact' },
        },
      );
    }

    if (params.status === 'confirmed' || params.status === 'canceled') {
      await this.reachMilestone(
        verification.integrationId,
        'firstCustomerResponseAt',
        'first_reply',
        {
          occurredAt,
          provenance: { first_customer_response: 'captured_exact' },
          props: { status: params.status },
        },
      );
      await this.markMilestone(
        verification.integrationId,
        'firstResolvedAt',
        occurredAt,
        { activation: 'captured_exact' },
      );
    }

    if (params.status === 'confirmed') {
      await this.markMilestone(
        verification.integrationId,
        'firstRealConfirmedAt',
        occurredAt,
        { first_real_confirmed: 'captured_exact' },
      );
    }
  }
}
