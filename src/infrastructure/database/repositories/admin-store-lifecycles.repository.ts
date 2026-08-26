import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { adminStoreLifecycles, orders, verifications } from '../schema';

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
  | 'paidSubscriptionActivatedAt';

@Injectable()
export class AdminStoreLifecyclesRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: PostgresJsDatabase<typeof schema>,
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
      return;
    }

    if (
      params.status === 'delivered' ||
      params.status === 'read' ||
      params.status === 'confirmed' ||
      params.status === 'canceled'
    ) {
      await this.markMilestone(
        verification.integrationId,
        'firstMessageDeliveredAt',
        occurredAt,
        { first_message_delivery: 'captured_exact' },
      );
    }

    if (params.status === 'confirmed' || params.status === 'canceled') {
      await this.markMilestone(
        verification.integrationId,
        'firstCustomerResponseAt',
        occurredAt,
        { first_customer_response: 'captured_exact' },
      );
      await this.markMilestone(
        verification.integrationId,
        'firstResolvedAt',
        occurredAt,
        { activation: 'captured_exact' },
      );
    }
  }
}
