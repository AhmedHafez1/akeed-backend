import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Column names the health expressions read. They must exist on the relation
 * the expressions are embedded in.
 */
export interface AdminHealthColumns {
  onboardingStatus: SQL;
  installedAt: SQL;
  onboardingCompletedAt: SQL;
  firstEligibleOrderAt: SQL;
  firstResolvedAt: SQL;
  uninstalledAt: SQL;
  usagePercent: SQL;
  failed24h: SQL;
  total24h: SQL;
  failedWebhooks1h: SQL;
  autoEnabled: SQL;
  billingStatus: SQL;
  lastActivityAt: SQL;
  creditBalanceState: SQL;
}

const BLOCKED_SUBSCRIPTION_STATUSES = [
  'cancelled',
  'canceled',
  'declined',
  'expired',
  'frozen',
];

@Injectable()
export class AdminHealthRuleService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Builds the health rules as SQL so the store list can filter, sort and
   * summarize by health inside the database.
   *
   * Signals are listed critical-first, each list in rule order, so the first
   * element of `critical || attention` is the top signal.
   */
  signalsSql(columns: AdminHealthColumns): { critical: SQL; attention: SQL } {
    const hoursSince = (value: SQL) =>
      sql`GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${value})) / 3600)`;
    const threshold = (key: string, fallback: number) =>
      sql`${this.number(key, fallback)}::numeric`;
    const failedRate = sql`(CASE WHEN ${columns.total24h} > 0 THEN ${columns.failed24h}::numeric / ${columns.total24h} ELSE 0 END)`;

    const onboardingAge = hoursSince(columns.installedAt);
    const onboardingPending = sql`${columns.onboardingStatus} <> 'completed'`;
    const onboardingCritical = sql`${onboardingPending} AND ${onboardingAge} >= ${threshold('ADMIN_HEALTH_ONBOARDING_CRITICAL_HOURS', 72)}`;
    const onboardingAttention = sql`${onboardingPending} AND ${onboardingAge} >= ${threshold('ADMIN_HEALTH_ONBOARDING_ATTENTION_HOURS', 24)}`;

    const awaitingOrder = sql`${columns.onboardingCompletedAt} IS NOT NULL AND ${columns.firstEligibleOrderAt} IS NULL`;
    const noOrderAge = hoursSince(columns.onboardingCompletedAt);
    const noOrderCritical = sql`${awaitingOrder} AND ${noOrderAge} >= ${threshold('ADMIN_HEALTH_NO_ORDER_CRITICAL_HOURS', 336)}`;
    const noOrderAttention = sql`${awaitingOrder} AND ${noOrderAge} >= ${threshold('ADMIN_HEALTH_NO_ORDER_ATTENTION_HOURS', 168)}`;

    const usageCritical = sql`${columns.usagePercent} >= ${threshold('ADMIN_HEALTH_USAGE_CRITICAL', 95)}`;
    const usageAttention = sql`${columns.usagePercent} >= ${threshold('ADMIN_HEALTH_USAGE_ATTENTION', 80)}`;

    const failureCritical = sql`${columns.total24h} >= ${threshold('ADMIN_HEALTH_FAILURE_CRITICAL_MINIMUM', 20)} AND ${failedRate} >= ${threshold('ADMIN_HEALTH_FAILURE_CRITICAL_RATE', 40)} / 100`;
    const failureAttention = sql`${columns.total24h} >= ${threshold('ADMIN_HEALTH_FAILURE_ATTENTION_MINIMUM', 10)} AND ${failedRate} >= ${threshold('ADMIN_HEALTH_FAILURE_ATTENTION_RATE', 20)} / 100`;

    const webhookCritical = sql`${columns.failedWebhooks1h} >= ${threshold('ADMIN_HEALTH_WEBHOOK_CRITICAL_COUNT', 3)}`;
    const webhookAttention = sql`${columns.failedWebhooks1h} >= ${threshold('ADMIN_HEALTH_WEBHOOK_ATTENTION_COUNT', 1)}`;

    const subscriptionBlocked = sql`${columns.onboardingStatus} = 'completed' AND COALESCE(${columns.billingStatus}, '') IN (${sql.join(
      BLOCKED_SUBSCRIPTION_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})`;

    const creditsExhausted = sql`${columns.creditBalanceState} IN ('zero', 'debt')`;
    const creditsLow = sql`${columns.creditBalanceState} = 'low'`;

    const idle = sql`${columns.firstResolvedAt} IS NOT NULL AND ${columns.lastActivityAt} IS NOT NULL`;
    const idleAge = hoursSince(columns.lastActivityAt);
    const idleCritical = sql`${idle} AND ${idleAge} >= ${threshold('ADMIN_HEALTH_INACTIVE_CRITICAL_HOURS', 336)}`;
    const idleAttention = sql`${idle} AND ${idleAge} >= ${threshold('ADMIN_HEALTH_INACTIVE_ATTENTION_HOURS', 168)}`;

    const signals = (entries: Array<[SQL, string]>) =>
      sql`array_remove(ARRAY[${sql.join(
        entries.map(
          ([condition, signal]) =>
            sql`CASE WHEN ${condition} THEN ${signal}::text END`,
        ),
        sql`, `,
      )}], NULL)`;

    // Uninstalling cancels billing and stops all activity, so every other rule
    // would fire as a side effect. An uninstalled store reports only that.
    const installed = sql`${columns.uninstalledAt} IS NULL`;
    const whileInstalled = (entries: Array<[SQL, string]>) =>
      entries.map(([condition, signal]): [SQL, string] => [
        sql`${installed} AND (${condition})`,
        signal,
      ]);

    return {
      critical: signals(
        whileInstalled([
          [onboardingCritical, 'onboarding_incomplete'],
          [noOrderCritical, 'no_eligible_order'],
          [usageCritical, 'usage_critical'],
          [failureCritical, 'failed_verification_rate'],
          [webhookCritical, 'webhook_failures'],
          [subscriptionBlocked, 'subscription_blocked'],
          [creditsExhausted, 'credits_exhausted'],
          [idleCritical, 'no_recent_activity'],
        ]),
      ),
      attention: signals([
        [sql`NOT (${installed})`, 'store_uninstalled'],
        ...whileInstalled([
          [
            sql`${onboardingAttention} AND NOT (${onboardingCritical})`,
            'onboarding_incomplete',
          ],
          [
            sql`${noOrderAttention} AND NOT (${noOrderCritical})`,
            'no_eligible_order',
          ],
          [
            sql`${usageAttention} AND NOT (${usageCritical})`,
            'usage_attention',
          ],
          [
            sql`${failureAttention} AND NOT (${failureCritical})`,
            'failed_verification_rate',
          ],
          [
            sql`${webhookAttention} AND NOT (${webhookCritical})`,
            'webhook_failures',
          ],
          [sql`NOT ${columns.autoEnabled}`, 'auto_confirmation_disabled'],
          [creditsLow, 'credits_low'],
          [
            sql`${idleAttention} AND NOT (${idleCritical})`,
            'no_recent_activity',
          ],
        ]),
      ]),
    };
  }

  private number(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
