import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import { creditModelNotices } from '../schema';

export type CreditModelNoticeEmailStatus = 'sent' | 'skipped' | 'failed';

/** The one-time notice about displayed credits, one row per organization. */
@Injectable()
export class CreditModelNoticesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async isVisible(orgId: string): Promise<boolean> {
    const rows = await this.db
      .select({ orgId: creditModelNotices.orgId })
      .from(creditModelNotices)
      .where(
        and(
          eq(creditModelNotices.orgId, orgId),
          isNull(creditModelNotices.dismissedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async dismiss(orgId: string): Promise<void> {
    await this.db
      .update(creditModelNotices)
      .set({ dismissedAt: sql`now()` })
      .where(
        and(
          eq(creditModelNotices.orgId, orgId),
          isNull(creditModelNotices.dismissedAt),
        ),
      );
  }

  /**
   * Takes a batch of organizations still owed the email. The claim commits
   * before anything is sent, so a crash can lose an email but never repeat one.
   */
  async claimEmailBatch(limit: number): Promise<string[]> {
    const rows = await this.db.execute<{ org_id: string }>(sql`
      UPDATE credit_model_notices
      SET email_claimed_at = now()
      WHERE org_id IN (
        SELECT org_id
        FROM credit_model_notices
        WHERE email_claimed_at IS NULL
        ORDER BY org_id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING org_id
    `);
    return rows.map((row) => row.org_id);
  }

  async markEmail(
    orgId: string,
    status: CreditModelNoticeEmailStatus,
    reason?: string,
  ): Promise<void> {
    await this.db
      .update(creditModelNotices)
      .set({ emailStatus: status, emailReason: reason ?? null })
      .where(eq(creditModelNotices.orgId, orgId));
  }
}
