import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { effectiveBillingStatusSql } from '../../shared/utils/billing.util';
import {
  ADMIN_HEALTH_SIGNALS,
  AdminHealthRuleService,
  type AdminHealthColumns,
} from './admin-health-rule.service';

const columns: AdminHealthColumns = {
  onboardingStatus: sql`onboarding_status`,
  installedAt: sql`installed_at`,
  onboardingCompletedAt: sql`onboarding_completed_at`,
  firstEligibleOrderAt: sql`first_eligible_order_at`,
  firstResolvedAt: sql`first_resolved_at`,
  uninstalledAt: sql`uninstalled_at`,
  usagePercent: sql`usage_percent`,
  failed24h: sql`failed_24h`,
  total24h: sql`total_24h`,
  failedWebhooks1h: sql`failed_webhooks_1h`,
  autoEnabled: sql`auto_confirmation_enabled`,
  billingStatus: sql`subscription_status`,
  lastActivityAt: sql`last_activity_at`,
  creditBalanceState: sql`credit_balance_state`,
  templateUnavailable: sql`template_unavailable`,
  templateDegraded: sql`template_degraded`,
  intakeReceived24h: sql`intake_received_24h`,
  intakeEligible24h: sql`intake_eligible_24h`,
  intakeSkipped24h: sql`intake_skipped_24h`,
  intakeBaseReceived: sql`intake_base_received`,
  intakeBaseEligible: sql`intake_base_eligible`,
  planBilled: sql`plan_billed`,
  uninstallPlanPaid: sql`uninstall_plan_paid`,
  uninstallWasActive: sql`uninstall_was_active`,
  hasPreviousInstall: sql`has_previous_install`,
};

function render(env: Record<string, string> = {}) {
  const service = new AdminHealthRuleService(new ConfigService(env));
  const { critical, attention } = service.signalsSql(columns);
  const dialect = new PgDialect();
  return {
    critical: dialect.sqlToQuery(critical),
    attention: dialect.sqlToQuery(attention),
  };
}

function signalOrder(params: unknown[]) {
  const known = new Set<unknown>(ADMIN_HEALTH_SIGNALS);
  return params.filter(
    (param): param is string => typeof param === 'string' && known.has(param),
  );
}

describe('AdminHealthRuleService', () => {
  it('lists critical and attention signals in rule order', () => {
    const { critical, attention } = render();

    expect(signalOrder(critical.params)).toEqual([
      'paid_store_uninstalled',
      'onboarding_incomplete',
      'no_eligible_order',
      'orders_not_eligible',
      'usage_critical',
      'failed_verification_rate',
      'webhook_failures',
      'reinstalled_without_plan',
      'subscription_blocked',
      'credits_exhausted',
      'template_unavailable',
      'no_recent_activity',
    ]);
    expect(signalOrder(attention.params)).toEqual([
      'store_uninstalled',
      'onboarding_incomplete',
      'no_eligible_order',
      'orders_not_eligible',
      'usage_attention',
      'failed_verification_rate',
      'webhook_failures',
      'auto_confirmation_disabled',
      'credits_low',
      'template_unavailable',
      'no_recent_activity',
    ]);
  });

  it('uses default thresholds when config is absent', () => {
    const { critical, attention } = render();

    expect(critical.params).toEqual(
      expect.arrayContaining([72, 336, 95, 20, 40, 3, 5, 90]),
    );
    expect(attention.params).toEqual(
      expect.arrayContaining([24, 168, 80, 10, 20, 1, 5, 50]),
    );
  });

  it('binds configured thresholds as parameters, never as SQL text', () => {
    const { critical } = render({
      ADMIN_HEALTH_USAGE_CRITICAL: '90',
      ADMIN_HEALTH_ONBOARDING_CRITICAL_HOURS: 'not-a-number',
    });

    expect(critical.params).toContain(90);
    expect(critical.params).not.toContain(95);
    expect(critical.params).toContain(72);
    expect(critical.sql).not.toContain('90');
  });

  it('reports only an uninstall signal once a store is uninstalled', () => {
    const { critical, attention } = render();
    const count = (text: string, pattern: RegExp) =>
      text.match(pattern)?.length ?? 0;
    const signalCases = /::text END/g;
    const gatedCases = /CASE WHEN uninstalled_at IS NULL AND \(/g;

    expect(count(critical.sql, signalCases)).toBe(12);
    expect(count(critical.sql, gatedCases)).toBe(11);
    expect(critical.sql).toMatch(
      /^array_remove\(ARRAY\[CASE WHEN NOT \(uninstalled_at IS NULL\) AND COALESCE\(uninstall_plan_paid AND uninstall_was_active, false\) THEN/,
    );

    expect(count(attention.sql, signalCases)).toBe(11);
    expect(count(attention.sql, gatedCases)).toBe(10);
    expect(attention.sql).toMatch(
      /^array_remove\(ARRAY\[CASE WHEN NOT \(uninstalled_at IS NULL\) AND NOT COALESCE\(uninstall_plan_paid AND uninstall_was_active, false\) THEN/,
    );
  });

  it('says what happened to a reinstalled store without a plan instead of subscription_blocked', () => {
    const { critical } = render();

    expect(critical.sql).toContain(
      "has_previous_install AND plan_billed AND onboarding_status = 'completed'",
    );
    expect(critical.sql).toMatch(
      /AND NOT \(has_previous_install AND plan_billed AND onboarding_status = 'completed'/,
    );
  });

  it('needs an eligible baseline and a minimum of orders before orders_not_eligible fires', () => {
    const { critical, attention } = render({
      ADMIN_HEALTH_INTAKE_BASELINE_MIN_ELIGIBLE: '8',
      ADMIN_HEALTH_INTAKE_MINIMUM: '6',
      ADMIN_HEALTH_INTAKE_CRITICAL_SKIP_RATE: '85',
      ADMIN_HEALTH_INTAKE_ATTENTION_DROP: '40',
    });

    expect(critical.sql).toMatch(
      /intake_base_eligible >= \$\d+::numeric AND intake_received_24h >= \$\d+::numeric AND intake_skipped_24h::numeric \/ NULLIF\(intake_received_24h, 0\) >= \$\d+::numeric \/ 100/,
    );
    expect(critical.params).toEqual(expect.arrayContaining([8, 6, 85]));
    expect(attention.params).toEqual(expect.arrayContaining([8, 6, 40]));
    expect(attention.sql).toContain(
      'intake_eligible_24h::numeric / NULLIF(intake_received_24h, 0) < (intake_base_eligible::numeric / NULLIF(intake_base_received, 0)) * (1 - ',
    );
  });

  it('raises template_unavailable as critical when nothing can be sent, and as attention when a template in use is unhealthy', () => {
    const { critical, attention } = render();

    expect(critical.sql).toContain(
      'CASE WHEN uninstalled_at IS NULL AND (template_unavailable) THEN',
    );
    expect(attention.sql).toContain(
      'CASE WHEN uninstalled_at IS NULL AND (template_degraded AND NOT (template_unavailable)) THEN',
    );
  });

  it('keeps attention signals exclusive of their critical level', () => {
    const { attention } = render();

    expect(attention.sql).toContain('AND NOT (');
    expect(attention.sql).toMatch(/^array_remove\(ARRAY\[/);
  });

  it('reads a live paid-through period as not blocked and a lapsed one as cancelled', () => {
    // Checked against Postgres: live paid_through -> no signal; lapsed or
    // undated -> 'cancelled' -> subscription_blocked, like any ended plan.
    const query = new PgDialect().sqlToQuery(
      effectiveBillingStatusSql(sql`i.billing_status`, sql`i.paid_through_at`),
    );
    expect(query.sql).toBe(
      "(CASE WHEN lower(btrim(COALESCE(i.billing_status, ''))) = $1 AND (i.paid_through_at IS NULL OR i.paid_through_at <= NOW()) THEN 'cancelled' ELSE i.billing_status END)",
    );
    expect(query.params).toEqual(['paid_through']);
    expect(render().critical.params).not.toContain('paid_through');
  });
});
