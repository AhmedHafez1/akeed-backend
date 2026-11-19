import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import {
  adminAccessAudit,
  announcementEmailDeliveries as deliveries,
  announcementEmailPreferences as preferences,
  organizations,
  tipsCampaigns,
} from '../schema';
import type {
  EmailMessage,
  EmailSendResult,
} from '../../../shared/ports/email.port';
import {
  ANNOUNCEMENT_MAX_ATTEMPTS,
  ANNOUNCEMENT_REPLAY_MS,
} from '../../../shared/tips-campaigns/announcement-email.policy';
import type { TipsAdminAudit } from './tips-campaigns.repository';

export type AnnouncementDelivery = typeof deliveries.$inferSelect;
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
export interface AnnouncementEmailStats {
  pending: number;
  processing: number;
  sent: number;
  skipped: number;
  failed: number;
  reasons: Record<string, number>;
}

@Injectable()
export class AnnouncementEmailsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async stats(campaignId: string): Promise<AnnouncementEmailStats> {
    const rows = await this.db.execute<{
      status: AnnouncementDelivery['status'];
      reason: string | null;
      count: number;
    }>(
      sql`SELECT status, reason, count(*)::int AS count FROM announcement_email_deliveries WHERE campaign_id = ${campaignId}::uuid GROUP BY status, reason`,
    );
    const result: AnnouncementEmailStats = {
      pending: 0,
      processing: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      reasons: {},
    };
    for (const row of rows) {
      result[row.status] += Number(row.count);
      if (row.reason)
        result.reasons[row.reason] =
          (result.reasons[row.reason] ?? 0) + Number(row.count);
    }
    return result;
  }

  async skipReason(row: AnnouncementDelivery): Promise<string | null> {
    const [result] = await this.db.execute<{ reason: string | null }>(sql`
      SELECT CASE
        WHEN c.email_stopped_at IS NOT NULL THEN 'stopped'
        WHEN EXISTS (SELECT 1 FROM announcement_email_preferences p WHERE p.org_id = ${row.orgId}::uuid) THEN 'unsubscribed'
        WHEN NOT EXISTS (SELECT 1 FROM integrations i WHERE i.org_id = ${row.orgId}::uuid AND i.is_active = true) THEN 'inactive'
        WHEN c.status = 'archived' OR c.expires_at <= now() THEN 'campaign_inactive'
        ELSE NULL END AS reason
      FROM tips_campaigns c WHERE c.id = ${row.campaignId}::uuid
    `);
    return result?.reason ?? null;
  }

  async stop(campaignId: string, audit: TipsAdminAudit): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [campaign] = await tx
        .select()
        .from(tipsCampaigns)
        .where(eq(tipsCampaigns.id, campaignId))
        .for('update');
      if (
        !campaign ||
        campaign.emailStoppedAt ||
        !campaign.announcementEmail ||
        campaign.status === 'draft'
      )
        return;
      await tx
        .update(tipsCampaigns)
        .set({ emailStoppedAt: sql`now()` })
        .where(eq(tipsCampaigns.id, campaignId));
      const rows = await tx
        .update(deliveries)
        .set({
          status: 'skipped',
          reason: 'stopped',
          emailPayload: null,
          claimToken: null,
          leaseUntil: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(deliveries.campaignId, campaignId),
            sql`${deliveries.status} IN ('pending', 'processing')`,
          ),
        )
        .returning({ orgId: deliveries.orgId });
      await tx.insert(adminAccessAudit).values({
        userId: audit.userId,
        requestId: audit.requestId,
        action: 'tips-campaign.email.stop',
        outcome: 'allowed',
        metadata: { campaignId, count: rows.length },
      });
    });
  }

  async unsubscribe(orgId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const org = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for('update');
      if (!org.length) return;
      await tx.insert(preferences).values({ orgId }).onConflictDoNothing();
    });
  }

  async claimSweep(intervalMs: number): Promise<string | null> {
    const token = randomUUID();
    const rows = await this.db.execute(
      sql`UPDATE announcement_email_dispatch_state SET claim_token = ${token}::uuid, lease_until = now() + interval '2 minutes', next_batch_at = now() + ${intervalMs} * interval '1 millisecond' WHERE id = 1 AND next_batch_at <= now() AND (lease_until IS NULL OR lease_until <= now()) RETURNING id`,
    );
    return rows.length ? token : null;
  }

  async finishSweep(token: string): Promise<void> {
    await this.db.execute(
      sql`UPDATE announcement_email_dispatch_state SET lease_until = NULL, claim_token = NULL WHERE id = 1 AND claim_token = ${token}::uuid`,
    );
  }

  async claimNext(sweepToken: string): Promise<AnnouncementDelivery | null> {
    return this.db.transaction(async (tx) => {
      const held = await tx.execute(
        sql`UPDATE announcement_email_dispatch_state SET lease_until = now() + interval '2 minutes' WHERE id = 1 AND claim_token = ${sweepToken}::uuid AND lease_until > now() RETURNING id`,
      );
      if (!held.length) return null;
      const [row] = await tx
        .update(deliveries)
        .set({
          status: 'processing',
          claimToken: randomUUID(),
          leaseUntil: sql`now() + interval '2 minutes'`,
          updatedAt: sql`now()`,
        })
        .where(
          sql`(${deliveries.campaignId}, ${deliveries.orgId}) IN (SELECT campaign_id, org_id FROM announcement_email_deliveries WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'processing' AND lease_until <= now()) ORDER BY next_attempt_at, campaign_id, org_id LIMIT 1 FOR UPDATE SKIP LOCKED)`,
        )
        .returning();
      return row ?? null;
    });
  }

  /** Prepare once. A changed merchant or campaign can never change a retry. */
  async prepare(
    row: AnnouncementDelivery,
    payload: EmailMessage,
  ): Promise<AnnouncementDelivery | null> {
    const [saved] = await this.db
      .update(deliveries)
      .set({ emailPayload: payload })
      .where(and(this.claim(row), sql`${deliveries.emailPayload} IS NULL`))
      .returning();
    return saved ?? (row.emailPayload ? row : null);
  }

  async skip(row: AnnouncementDelivery, reason: string): Promise<void> {
    await this.db
      .update(deliveries)
      .set({
        status: 'skipped',
        reason,
        emailPayload: null,
        claimToken: null,
        leaseUntil: null,
        updatedAt: sql`now()`,
      })
      .where(this.claim(row));
  }

  async fail(row: AnnouncementDelivery, reason: string): Promise<void> {
    await this.db
      .update(deliveries)
      .set({
        status: 'failed',
        reason,
        emailPayload: null,
        claimToken: null,
        leaseUntil: null,
        updatedAt: sql`now()`,
      })
      .where(this.claim(row));
  }

  /**
   * Campaign and organization locks serialize Stop/unsubscribe with the bounded
   * provider request. A completed Stop cannot admit a later request. The saved
   * envelope survives a rollback after provider acceptance for a safe replay.
   */
  async dispatch(
    row: AnnouncementDelivery,
    enabled: () => boolean,
    send: (message: EmailMessage) => Promise<EmailSendResult>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [campaign] = await tx
        .select()
        .from(tipsCampaigns)
        .where(eq(tipsCampaigns.id, row.campaignId))
        .for('update');
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, row.orgId))
        .for('update');
      const [current] = await tx
        .select()
        .from(deliveries)
        .where(this.claim(row))
        .for('update');
      if (!current || !campaign) return;
      if (!enabled()) {
        await this.settle(tx, current, 'pending', 'sending_disabled');
        return;
      }
      const rejection = await this.rejection(tx, current, campaign);
      if (rejection) {
        await this.settle(tx, current, 'skipped', rejection);
        return;
      }
      if (
        current.firstAttemptAt &&
        Date.now() - Date.parse(current.firstAttemptAt) >=
          ANNOUNCEMENT_REPLAY_MS
      ) {
        await this.settle(tx, current, 'failed', 'provider_outcome_unresolved');
        return;
      }
      if (!current.emailPayload) {
        await this.settle(tx, current, 'failed', 'email_payload_missing');
        return;
      }
      // Persist the attempt outside this transaction before calling dispatch;
      // firstAttemptAt must survive a crash/rollback of the provider result.
      let result: EmailSendResult;
      try {
        result = await send(current.emailPayload);
      } catch {
        result = {
          status: 'failed',
          reason: 'provider_outcome_unknown',
          retryable: true,
          uncertain: true,
        };
      }
      if (result.status === 'sent')
        await this.settle(tx, current, 'sent', null);
      else if (result.status === 'skipped')
        await this.settle(tx, current, 'pending', 'sending_disabled');
      else if (result.retryable && current.attempts < ANNOUNCEMENT_MAX_ATTEMPTS)
        await this.settle(tx, current, 'pending', result.reason);
      else await this.settle(tx, current, 'failed', result.reason);
      await tx.insert(adminAccessAudit).values({
        userId: campaign.publishedBy,
        action: 'tips-campaign.email.send',
        outcome: 'allowed',
        metadata: {
          campaignId: row.campaignId,
          orgId: row.orgId,
          count: 1,
          status: result.status,
          attempt: current.attempts,
          actor: 'worker',
        },
      });
    });
  }

  /** Write-ahead marker: retry deadlines survive loss of the provider response. */
  async startAttempt(
    row: AnnouncementDelivery,
  ): Promise<AnnouncementDelivery | null> {
    const [updated] = await this.db
      .update(deliveries)
      .set({
        firstAttemptAt: sql`COALESCE(${deliveries.firstAttemptAt}, now())`,
        attempts: sql`${deliveries.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          this.claim(row),
          sql`${deliveries.attempts} < ${ANNOUNCEMENT_MAX_ATTEMPTS}`,
          sql`(${deliveries.firstAttemptAt} IS NULL OR ${deliveries.firstAttemptAt} > now() - ${ANNOUNCEMENT_REPLAY_MS} * interval '1 millisecond')`,
        ),
      )
      .returning();
    return updated ?? null;
  }

  private claim(row: AnnouncementDelivery) {
    return and(
      eq(deliveries.campaignId, row.campaignId),
      eq(deliveries.orgId, row.orgId),
      eq(deliveries.status, 'processing'),
      eq(deliveries.claimToken, row.claimToken ?? ''),
      sql`${deliveries.leaseUntil} > now()`,
    );
  }

  private async rejection(
    tx: Tx,
    row: AnnouncementDelivery,
    campaign: typeof tipsCampaigns.$inferSelect,
  ): Promise<string | null> {
    if (campaign.emailStoppedAt) return 'stopped';
    if (
      campaign.status === 'archived' ||
      (campaign.expiresAt && Date.parse(campaign.expiresAt) <= Date.now())
    )
      return 'campaign_inactive';
    const optedOut = await tx
      .select({ orgId: preferences.orgId })
      .from(preferences)
      .where(eq(preferences.orgId, row.orgId));
    if (optedOut.length) return 'unsubscribed';
    const active = await tx.execute(
      sql`SELECT 1 FROM integrations WHERE org_id = ${row.orgId}::uuid AND is_active = true LIMIT 1`,
    );
    return active.length ? null : 'inactive';
  }

  private async settle(
    tx: Tx,
    row: AnnouncementDelivery,
    status: AnnouncementDelivery['status'],
    reason: string | null,
  ): Promise<void> {
    await tx
      .update(deliveries)
      .set({
        status,
        reason,
        claimToken: null,
        leaseUntil: null,
        emailPayload: status === 'pending' ? row.emailPayload : null,
        nextAttemptAt: sql`now() + ${Math.min(300000 * 2 ** Math.max(0, row.attempts - 1), 3600000)} * interval '1 millisecond'`,
        sentAt: status === 'sent' ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(this.claim(row));
  }
}
