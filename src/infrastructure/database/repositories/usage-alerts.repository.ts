import { Inject, Injectable } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '../index';
import { DRIZZLE } from '../database.provider';
import { usageAlerts } from '../schema';
import type {
  CreditAlertLevel,
  UsageAlertEmailStatus,
  UsageAlertKind,
  UsageAlertLevel,
} from '../../../shared/billing/usage-alert.policy';

/** Addresses a Shopify install is created with; nobody reads them. */
const PLACEHOLDER_EMAIL_DOMAIN = '@akeed-shopify.internal';

/**
 * One row per usage alert. The unique indexes are the dedupe: whoever inserts
 * the row owns the email, so a retried job, a duplicate event or a second
 * worker finds the row taken and sends nothing.
 */
@Injectable()
export class UsageAlertsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  /** Records the alert unless it already exists; returns its id if new. */
  async claim(params: {
    orgId: string;
    integrationId: string;
    kind: UsageAlertKind;
    level: UsageAlertLevel;
    cycleKey: string;
  }): Promise<string | null> {
    const [row] = await this.db
      .insert(usageAlerts)
      .values(params)
      .onConflictDoNothing()
      .returning({ id: usageAlerts.id });
    return row?.id ?? null;
  }

  async markEmail(
    id: string,
    status: Exclude<UsageAlertEmailStatus, 'pending'>,
    error: string | null = null,
  ): Promise<void> {
    await this.db
      .update(usageAlerts)
      .set({
        emailStatus: status,
        emailError: error,
        sentAt: status === 'sent' ? new Date().toISOString() : null,
      })
      .where(eq(usageAlerts.id, id));
  }

  /**
   * Closes the org's open credit alerts at these levels: the balance is back
   * above them, so a later dip is a new incident and alerts again.
   */
  async resolveOpenCreditAlerts(
    orgId: string,
    levels: CreditAlertLevel[],
  ): Promise<number> {
    if (levels.length === 0) return 0;
    const rows = await this.db
      .update(usageAlerts)
      .set({ resolvedAt: new Date().toISOString() })
      .where(
        and(
          eq(usageAlerts.orgId, orgId),
          eq(usageAlerts.kind, 'credit_balance'),
          inArray(usageAlerts.level, levels),
          isNull(usageAlerts.resolvedAt),
        ),
      )
      .returning({ id: usageAlerts.id });
    return rows.length;
  }

  /**
   * The org owner's sign-in email, or null for a Shopify install, whose user
   * has a placeholder address. The oldest owner wins, as on the staff pages.
   */
  async findOwnerEmail(orgId: string): Promise<string | null> {
    const rows = await this.db.execute<{ email: string | null }>(sql`
      SELECT owner_user.email
      FROM memberships membership
      INNER JOIN auth.users owner_user ON owner_user.id = membership.user_id
      WHERE membership.org_id = ${orgId} AND membership.role = 'owner'
      ORDER BY membership.created_at ASC
      LIMIT 1
    `);
    const email = rows[0]?.email?.trim() ?? '';
    return email.length > 0 &&
      !email.toLowerCase().endsWith(PLACEHOLDER_EMAIL_DOMAIN)
      ? email
      : null;
  }
}
