import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database.provider';
import type { CreditUsage } from '../../../shared/billing/credit-usage.types';

@Injectable()
export class CreditUsageRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async read(
    orgId: string,
    timeZone: string,
    asOf: string,
  ): Promise<CreditUsage | null> {
    // One statement gives month and chart the same snapshot. Local dates are
    // converted by Postgres, including 23/25-hour days and month boundaries.
    const [row] = await this.db.execute<{ result: CreditUsage | null }>(sql`
      WITH clock AS (
        SELECT ${asOf}::timestamptz AS at, ${timeZone}::text AS zone
      ), bounds AS (
        SELECT at, zone, (at AT TIME ZONE zone)::date AS today,
          date_trunc('month', at AT TIME ZONE zone)::date AS month_start FROM clock
      ), costs AS (
        SELECT (d.accepted_at AT TIME ZONE b.zone)::date AS day, d.sender_kind,
          CASE WHEN d.billing_refunded_at IS NOT NULL THEN 0
            WHEN d.billing_cost IS NOT NULL THEN d.billing_cost
            ELSE (SELECT CASE WHEN COUNT(*) > 0 THEN GREATEST(0, -SUM(l.quantity)) * 2 END
              FROM credit_ledger_entries l
              WHERE l.org_id = d.org_id AND l.dispatch_id = d.id
                AND l.type::text IN ('consumption', 'failure_reversal'))
          END::int AS credits
        FROM verification_message_dispatches d CROSS JOIN bounds b
        WHERE d.org_id = ${orgId} AND d.accounting_mode = 'prepaid_credit'
          AND d.accepted_at >= (LEAST(b.month_start, b.today - 13)::timestamp AT TIME ZONE b.zone)
          AND d.accepted_at <= b.at
          AND coalesce(d.metadata->>'billingExempt', 'false') <> 'true'
      ), totals AS (
        SELECT COALESCE(SUM(credits), 0)::int AS used,
          COALESCE(SUM(credits) FILTER (WHERE sender_kind = 'akeed_system'), 0)::int AS akeed,
          COALESCE(SUM(credits) FILTER (WHERE sender_kind = 'merchant_own'), 0)::int AS own
        FROM costs CROSS JOIN bounds WHERE day >= month_start
      ), days AS (
        SELECT b.today - offset_day AS day FROM bounds b CROSS JOIN generate_series(13, 0, -1) offset_day
      ), daily AS (
        SELECT days.day, COALESCE(SUM(c.credits), 0)::int AS credits,
          COALESCE(SUM(c.credits) FILTER (WHERE c.sender_kind = 'akeed_system'), 0)::int AS akeed,
          COALESCE(SUM(c.credits) FILTER (WHERE c.sender_kind = 'merchant_own'), 0)::int AS own
        FROM days LEFT JOIN costs c ON c.day = days.day GROUP BY days.day
      )
      SELECT CASE WHEN EXISTS (SELECT 1 FROM costs WHERE credits IS NULL) THEN NULL
        ELSE jsonb_build_object('asOf', ${asOf}::text, 'timeZone', b.zone,
        'monthStart', b.month_start::text, 'usedThisMonth', t.used,
        'bySender', jsonb_build_object('akeed', t.akeed, 'ownNumber', t.own),
        'daily', (SELECT jsonb_agg(jsonb_build_object('date', day::text, 'credits', credits,
          'akeedCredits', akeed, 'ownNumberCredits', own) ORDER BY day) FROM daily)) END AS result
      FROM bounds b CROSS JOIN totals t
    `);
    if (!row) throw new Error('Credit usage snapshot unavailable');
    return row.result;
  }
}
