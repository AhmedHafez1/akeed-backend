import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminHealthStatus } from './admin.types';

export interface AdminHealthFacts {
  onboardingStatus: string;
  installedAt: string;
  onboardingCompletedAt: string | null;
  firstEligibleOrderAt: string | null;
  firstResolvedAt: string | null;
  uninstalledAt: string | null;
  usagePercent: number;
  failed24h: number;
  total24h: number;
  failedWebhooks1h: number;
  autoEnabled: boolean;
  billingStatus: string | null;
  lastActivityAt: string | null;
}

@Injectable()
export class AdminHealthRuleService {
  constructor(private readonly config: ConfigService) {}

  evaluate(
    facts: AdminHealthFacts,
    now = new Date(),
  ): {
    status: AdminHealthStatus;
    top_signal: string | null;
    signal_count: number;
  } {
    const attention: string[] = [];
    const critical: string[] = [];
    const ageHours = this.ageHours(facts.installedAt, now);

    if (facts.uninstalledAt) attention.push('store_uninstalled');
    if (facts.onboardingStatus !== 'completed') {
      if (
        ageHours >= this.number('ADMIN_HEALTH_ONBOARDING_CRITICAL_HOURS', 72)
      ) {
        critical.push('onboarding_incomplete');
      } else if (
        ageHours >= this.number('ADMIN_HEALTH_ONBOARDING_ATTENTION_HOURS', 24)
      ) {
        attention.push('onboarding_incomplete');
      }
    }

    if (facts.onboardingCompletedAt && !facts.firstEligibleOrderAt) {
      const noOrderHours = this.ageHours(facts.onboardingCompletedAt, now);
      if (
        noOrderHours >= this.number('ADMIN_HEALTH_NO_ORDER_CRITICAL_HOURS', 336)
      ) {
        critical.push('no_eligible_order');
      } else if (
        noOrderHours >=
        this.number('ADMIN_HEALTH_NO_ORDER_ATTENTION_HOURS', 168)
      ) {
        attention.push('no_eligible_order');
      }
    }

    if (facts.usagePercent >= this.number('ADMIN_HEALTH_USAGE_CRITICAL', 95)) {
      critical.push('usage_critical');
    } else if (
      facts.usagePercent >= this.number('ADMIN_HEALTH_USAGE_ATTENTION', 80)
    ) {
      attention.push('usage_attention');
    }

    const failedRate =
      facts.total24h > 0 ? facts.failed24h / facts.total24h : 0;
    if (
      facts.total24h >=
        this.number('ADMIN_HEALTH_FAILURE_CRITICAL_MINIMUM', 20) &&
      failedRate >= this.number('ADMIN_HEALTH_FAILURE_CRITICAL_RATE', 40) / 100
    ) {
      critical.push('failed_verification_rate');
    } else if (
      facts.total24h >=
        this.number('ADMIN_HEALTH_FAILURE_ATTENTION_MINIMUM', 10) &&
      failedRate >= this.number('ADMIN_HEALTH_FAILURE_ATTENTION_RATE', 20) / 100
    ) {
      attention.push('failed_verification_rate');
    }

    if (
      facts.failedWebhooks1h >=
      this.number('ADMIN_HEALTH_WEBHOOK_CRITICAL_COUNT', 3)
    )
      critical.push('webhook_failures');
    else if (
      facts.failedWebhooks1h >=
      this.number('ADMIN_HEALTH_WEBHOOK_ATTENTION_COUNT', 1)
    )
      attention.push('webhook_failures');
    if (!facts.autoEnabled) attention.push('auto_confirmation_disabled');
    if (
      facts.onboardingStatus === 'completed' &&
      ['cancelled', 'canceled', 'declined', 'expired', 'frozen'].includes(
        facts.billingStatus ?? '',
      )
    ) {
      critical.push('subscription_blocked');
    }

    if (facts.firstResolvedAt && facts.lastActivityAt) {
      const idleHours = this.ageHours(facts.lastActivityAt, now);
      if (
        idleHours >= this.number('ADMIN_HEALTH_INACTIVE_CRITICAL_HOURS', 336)
      ) {
        critical.push('no_recent_activity');
      } else if (
        idleHours >= this.number('ADMIN_HEALTH_INACTIVE_ATTENTION_HOURS', 168)
      ) {
        attention.push('no_recent_activity');
      }
    }

    const signals = [...critical, ...attention];
    return {
      status:
        critical.length > 0
          ? 'critical'
          : attention.length > 0
            ? 'attention_required'
            : 'healthy',
      top_signal: signals[0] ?? null,
      signal_count: signals.length,
    };
  }

  private number(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private ageHours(value: string, now: Date): number {
    return Math.max(0, (now.getTime() - new Date(value).getTime()) / 3_600_000);
  }
}
