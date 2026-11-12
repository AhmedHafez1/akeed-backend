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
  /** No template can be sent for a language the store sends in. */
  templateUnavailable: SQL;
  /** A template the store sends is unhealthy at the provider. */
  templateDegraded: SQL;
  /** Unique orders received, eligible and skipped in the last 24 hours. */
  intakeReceived24h: SQL;
  intakeEligible24h: SQL;
  intakeSkipped24h: SQL;
  /** Unique orders received and eligible in the 7 days before that. */
  intakeBaseReceived: SQL;
  intakeBaseEligible: SQL;
  /** The store is billed by plan (not prepaid credits). */
  planBilled: SQL;
  /** The plan at uninstall was a paid one. */
  uninstallPlanPaid: SQL;
  /** The plan was active (or paid through) when the store uninstalled. */
  uninstallWasActive: SQL;
  /** The current installation follows an earlier, uninstalled one. */
  hasPreviousInstall: SQL;
}

/**
 * Every signal a store can carry, critical rules first. The store list
 * filters on these codes and the dashboard labels them.
 */
export const ADMIN_HEALTH_SIGNALS = [
  'paid_store_uninstalled',
  'store_uninstalled',
  'onboarding_incomplete',
  'no_eligible_order',
  'orders_not_eligible',
  'usage_critical',
  'usage_attention',
  'failed_verification_rate',
  'webhook_failures',
  'reinstalled_without_plan',
  'subscription_blocked',
  'credits_exhausted',
  'credits_low',
  'template_unavailable',
  'auto_confirmation_disabled',
  'no_recent_activity',
] as const;

export type AdminHealthSignal = (typeof ADMIN_HEALTH_SIGNALS)[number];

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

    // A store that reinstalled, finished setup and has no plan: the plan was
    // lost with the uninstall. It reads as that, not as a blocked plan.
    const reinstalledWithoutPlan = sql`${columns.hasPreviousInstall} AND ${columns.planBilled} AND ${columns.onboardingStatus} = 'completed' AND lower(btrim(COALESCE(${columns.billingStatus}, ''))) NOT IN ('active', 'paid_through', 'not_required')`;

    // Orders keep arriving but are no longer confirmed, for a store that
    // normally confirms orders: never-COD stores have no baseline.
    const intakeBaseline = sql`${columns.intakeBaseEligible} >= ${threshold('ADMIN_HEALTH_INTAKE_BASELINE_MIN_ELIGIBLE', 5)} AND ${columns.intakeReceived24h} >= ${threshold('ADMIN_HEALTH_INTAKE_MINIMUM', 5)}`;
    const intakeCritical = sql`${intakeBaseline} AND ${columns.intakeSkipped24h}::numeric / NULLIF(${columns.intakeReceived24h}, 0) >= ${threshold('ADMIN_HEALTH_INTAKE_CRITICAL_SKIP_RATE', 90)} / 100`;
    const intakeAttention = sql`${intakeBaseline} AND ${columns.intakeEligible24h}::numeric / NULLIF(${columns.intakeReceived24h}, 0) < (${columns.intakeBaseEligible}::numeric / NULLIF(${columns.intakeBaseReceived}, 0)) * (1 - ${threshold('ADMIN_HEALTH_INTAKE_ATTENTION_DROP', 50)} / 100)`;

    const paidStoreUninstalled = sql`${columns.uninstallPlanPaid} AND ${columns.uninstallWasActive}`;

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
      critical: signals([
        [
          sql`NOT (${installed}) AND COALESCE(${paidStoreUninstalled}, false)`,
          'paid_store_uninstalled',
        ],
        ...whileInstalled([
          [onboardingCritical, 'onboarding_incomplete'],
          [noOrderCritical, 'no_eligible_order'],
          [intakeCritical, 'orders_not_eligible'],
          [usageCritical, 'usage_critical'],
          [failureCritical, 'failed_verification_rate'],
          [webhookCritical, 'webhook_failures'],
          [reinstalledWithoutPlan, 'reinstalled_without_plan'],
          [
            sql`${subscriptionBlocked} AND NOT (${reinstalledWithoutPlan})`,
            'subscription_blocked',
          ],
          [creditsExhausted, 'credits_exhausted'],
          [columns.templateUnavailable, 'template_unavailable'],
          [idleCritical, 'no_recent_activity'],
        ]),
      ]),
      attention: signals([
        [
          sql`NOT (${installed}) AND NOT COALESCE(${paidStoreUninstalled}, false)`,
          'store_uninstalled',
        ],
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
            sql`COALESCE(${intakeAttention}, false) AND NOT COALESCE(${intakeCritical}, false)`,
            'orders_not_eligible',
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
            sql`${columns.templateDegraded} AND NOT (${columns.templateUnavailable})`,
            'template_unavailable',
          ],
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
