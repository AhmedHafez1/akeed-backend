import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
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
  const known = new Set([
    'store_uninstalled',
    'onboarding_incomplete',
    'no_eligible_order',
    'usage_critical',
    'usage_attention',
    'failed_verification_rate',
    'webhook_failures',
    'auto_confirmation_disabled',
    'subscription_blocked',
    'credits_exhausted',
    'credits_low',
    'no_recent_activity',
  ]);
  return params.filter(
    (param): param is string => typeof param === 'string' && known.has(param),
  );
}

describe('AdminHealthRuleService', () => {
  it('lists critical and attention signals in rule order', () => {
    const { critical, attention } = render();

    expect(signalOrder(critical.params)).toEqual([
      'onboarding_incomplete',
      'no_eligible_order',
      'usage_critical',
      'failed_verification_rate',
      'webhook_failures',
      'subscription_blocked',
      'credits_exhausted',
      'no_recent_activity',
    ]);
    expect(signalOrder(attention.params)).toEqual([
      'store_uninstalled',
      'onboarding_incomplete',
      'no_eligible_order',
      'usage_attention',
      'failed_verification_rate',
      'webhook_failures',
      'auto_confirmation_disabled',
      'credits_low',
      'no_recent_activity',
    ]);
  });

  it('uses default thresholds when config is absent', () => {
    const { critical, attention } = render();

    expect(critical.params).toEqual(
      expect.arrayContaining([72, 336, 95, 20, 40, 3]),
    );
    expect(attention.params).toEqual(
      expect.arrayContaining([24, 168, 80, 10, 20, 1]),
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

  it('reports only store_uninstalled once a store is uninstalled', () => {
    const { critical, attention } = render();
    const count = (text: string, pattern: RegExp) =>
      text.match(pattern)?.length ?? 0;
    const signalCases = /::text END/g;
    const gatedCases = /CASE WHEN uninstalled_at IS NULL AND \(/g;

    expect(count(critical.sql, signalCases)).toBe(8);
    expect(count(critical.sql, gatedCases)).toBe(8);

    expect(count(attention.sql, signalCases)).toBe(9);
    expect(count(attention.sql, gatedCases)).toBe(8);
    expect(attention.sql).toMatch(
      /^array_remove\(ARRAY\[CASE WHEN NOT \(uninstalled_at IS NULL\) THEN/,
    );
  });

  it('keeps attention signals exclusive of their critical level', () => {
    const { attention } = render();

    expect(attention.sql).toContain('AND NOT (');
    expect(attention.sql).toMatch(/^array_remove\(ARRAY\[/);
  });
});
