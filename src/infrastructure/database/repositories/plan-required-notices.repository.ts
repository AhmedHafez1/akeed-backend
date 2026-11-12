import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { adminStoreLifecycles, integrations } from '../schema';
import { isBillingStatusActive } from '../../../shared/utils/billing.util';
import type { EmailMessage } from '../../../shared/ports/email.port';

export interface PlanRequiredNotice {
  id: string;
  orgId: string;
  integrationId: string;
  lifecycleId: string;
  attempts: number;
  firstAttemptAt: string | null;
  emailPayload: EmailMessage | null;
}

@Injectable()
export class PlanRequiredNoticesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Setup completion and notice eligibility commit together under the source lock. */
  async completeSetup(orgId: string, integrationId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.orgId, orgId),
          ),
        )
        .for('update');
      if (
        !source ||
        source.platformType !== 'shopify' ||
        source.isActive !== true
      )
        return false;
      let [lifecycle] = await tx
        .select()
        .from(adminStoreLifecycles)
        .where(
          and(
            eq(adminStoreLifecycles.integrationId, integrationId),
            eq(adminStoreLifecycles.orgId, orgId),
            isNull(adminStoreLifecycles.uninstalledAt),
          ),
        );
      if (!lifecycle)
        [lifecycle] = await tx
          .insert(adminStoreLifecycles)
          .values({
            orgId,
            integrationId,
            installedAt: new Date().toISOString(),
          })
          .returning();
      const first = !lifecycle.setupCompletedAt;
      await tx
        .update(integrations)
        .set({ onboardingStatus: 'completed' })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.orgId, orgId),
          ),
        );
      await tx
        .update(adminStoreLifecycles)
        .set({
          setupCompletedAt:
            lifecycle.setupCompletedAt ?? new Date().toISOString(),
          onboardingCompletedAt:
            lifecycle.onboardingCompletedAt ?? new Date().toISOString(),
        })
        .where(eq(adminStoreLifecycles.id, lifecycle.id));
      if (
        first &&
        !isBillingStatusActive(source.billingStatus, source.paidThroughAt)
      ) {
        await tx.execute(sql`INSERT INTO plan_required_notices (org_id,integration_id,lifecycle_id)
          VALUES (${orgId}::uuid,${integrationId}::uuid,${lifecycle.id}::uuid) ON CONFLICT (lifecycle_id) DO NOTHING`);
      }
      return first;
    });
  }

  async countMissedOrders(source: typeof integrations.$inferSelect, now: Date) {
    const [lifecycle] = await this.db
      .select({ installedAt: adminStoreLifecycles.installedAt })
      .from(adminStoreLifecycles)
      .where(
        and(
          eq(adminStoreLifecycles.orgId, source.orgId),
          eq(adminStoreLifecycles.integrationId, source.id),
          isNull(adminStoreLifecycles.uninstalledAt),
        ),
      );
    if (!lifecycle) return null;
    const since = new Date(
      Math.max(
        now.getTime() - 48 * 3_600_000,
        Date.parse(lifecycle.installedAt),
        source.billingCanceledAt ? Date.parse(source.billingCanceledAt) : 0,
      ),
    ).toISOString();
    const [row] = await this.db.execute<{ count: number }>(sql`
      SELECT count(DISTINCT w.raw_payload->>'id')::int AS count FROM webhook_events w
      WHERE w.org_id=${source.orgId}::uuid AND w.integration_id=${source.id}::uuid
        AND w.platform='shopify' AND w.job_type='order.create' AND w.status='skipped'
        AND w.last_error='billing_not_active' AND w.received_at >= ${since}::timestamptz AND w.received_at <= ${now.toISOString()}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM orders o INNER JOIN verifications v ON v.order_id=o.id AND v.org_id=o.org_id
          WHERE o.org_id=w.org_id AND o.integration_id=w.integration_id AND o.external_order_id=w.raw_payload->>'id' AND v.status='confirmed')`);
    return { count: Number(row?.count ?? 0), since, until: now.toISOString() };
  }

  async claim(): Promise<PlanRequiredNotice | null> {
    const rows = await this.db.execute(sql`
      WITH candidate AS (SELECT id FROM plan_required_notices
        WHERE (status='pending' AND next_attempt_at<=now()) OR (status='sending' AND lease_until<=now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE plan_required_notices n SET status='sending', attempts=attempts+1, lease_until=now()+interval '2 minutes'
      FROM candidate c WHERE n.id=c.id RETURNING n.id,n.org_id AS "orgId",n.integration_id AS "integrationId",
        n.lifecycle_id AS "lifecycleId",n.attempts,n.first_attempt_at AS "firstAttemptAt",n.email_payload AS "emailPayload"`);
    return (rows[0] as unknown as PlanRequiredNotice) ?? null;
  }

  async context(notice: PlanRequiredNotice) {
    const [row] = await this.db
      .select({
        source: integrations,
        uninstalledAt: adminStoreLifecycles.uninstalledAt,
      })
      .from(integrations)
      .innerJoin(
        adminStoreLifecycles,
        and(
          eq(adminStoreLifecycles.integrationId, integrations.id),
          eq(adminStoreLifecycles.orgId, integrations.orgId),
        ),
      )
      .where(
        and(
          eq(integrations.orgId, notice.orgId),
          eq(integrations.id, notice.integrationId),
          eq(adminStoreLifecycles.id, notice.lifecycleId),
        ),
      );
    return row;
  }

  async prepare(
    notice: PlanRequiredNotice,
    payload: EmailMessage,
  ): Promise<boolean> {
    const rows = await this.db
      .execute(sql`UPDATE plan_required_notices SET email_payload=${JSON.stringify(payload)}::jsonb,first_attempt_at=now()
      WHERE id=${notice.id}::uuid AND org_id=${notice.orgId}::uuid AND status='sending' AND attempts=${notice.attempts} RETURNING id`);
    return rows.length > 0;
  }

  async settle(
    notice: PlanRequiredNotice,
    status: 'pending' | 'sent' | 'skipped' | 'failed',
    reason: string | null = null,
    delayMs = 0,
  ) {
    await this.db
      .execute(sql`UPDATE plan_required_notices SET status=${status},reason=${reason},lease_until=NULL,
      next_attempt_at=now()+${delayMs}*interval '1 millisecond',sent_at=CASE WHEN ${status}='sent' THEN now() ELSE sent_at END
      WHERE id=${notice.id}::uuid AND org_id=${notice.orgId}::uuid AND status='sending' AND attempts=${notice.attempts}`);
  }
}
