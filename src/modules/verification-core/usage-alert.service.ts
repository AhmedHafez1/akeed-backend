import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { UsageAlertsRepository } from '../../infrastructure/database/repositories/usage-alerts.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import type { integrations } from '../../infrastructure/database/schema';
import { BillingEntitlementService } from './billing-entitlement.service';
import {
  capacityAction,
  CREDIT_ALERT_CYCLE_KEY,
  creditAlertLevels,
  planUsageAlertLevels,
  planUsageCycleKey,
  recoveredCreditLevels,
  type UsageAlertKind,
  type UsageAlertLevel,
} from '../../shared/billing/usage-alert.policy';
import {
  buildUsageAlertEmail,
  usageAlertLanguage,
  type UsageAlertFacts,
} from '../../shared/notifications/usage-alert-copy';
import { EMAIL_PORT, type EmailPort } from '../../shared/ports/email.port';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

type IntegrationRecord = typeof integrations.$inferSelect;

interface ClaimedAlert {
  id: string;
  level: UsageAlertLevel;
}

/**
 * Tells a merchant that sending capacity is running out or gone.
 *
 * Plan allowances alert at 80%, 95% and 100% once per billing period; prepaid
 * credits alert when the balance reaches the low threshold and when it runs
 * out, once per incident until the balance recovers. Each alert is a row
 * whose unique index is the dedupe, so a page refresh, a retried job or a
 * duplicate event never sends a second email.
 *
 * Called after a send, when an order is blocked and after recovery; never
 * from a read. Best effort: a failure is logged and never reaches the caller,
 * whose send or block has already happened.
 */
@Injectable()
export class UsageAlertService {
  private readonly logger = new Logger(UsageAlertService.name);

  constructor(
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly entitlements: BillingEntitlementService,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly alerts: UsageAlertsRepository,
    private readonly config: ConfigService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  async evaluateOrg(orgId: string): Promise<void> {
    try {
      const sources = await this.integrationsRepo.findActiveByOrg(orgId);
      let blockedCount: number | null = null;
      const blocked = async () =>
        (blockedCount ??= await this.verificationsRepo.countBlocked(orgId));
      // Credits belong to the org, so one source speaks for them.
      let creditsEvaluated = false;
      for (const source of sources) {
        if (this.entitlements.accountingModeFor(source) === 'prepaid_credit') {
          if (creditsEvaluated) continue;
          creditsEvaluated = true;
          await this.evaluateCredits(source, blocked);
        } else {
          await this.evaluatePlan(source, blocked);
        }
      }
    } catch (error) {
      this.logger.warn(
        buildBackendLog(UsageAlertService.name, {
          action: 'usage-alert-evaluate',
          outcome: 'failure',
          orgId,
          ...normalizeError(error),
        }),
      );
    }
  }

  private async evaluatePlan(
    source: IntegrationRecord,
    blocked: () => Promise<number>,
  ): Promise<void> {
    const entitlement = await this.entitlements.readEntitlement({
      id: source.id,
      orgId: source.orgId,
    });
    // An inactive or unpaid source is refused for that reason, not capacity.
    if (!entitlement.allowed) return;
    const levels = planUsageAlertLevels(
      entitlement.consumedCount,
      entitlement.includedLimit,
    );
    const alert = await this.claimHighest(
      source,
      'plan_usage',
      levels,
      planUsageCycleKey(entitlement.planId, entitlement.periodStart),
    );
    if (!alert) return;
    await this.deliver(alert, source, {
      level: alert.level,
      storeName: source.storeName ?? null,
      used: entitlement.consumedCount,
      limit: entitlement.includedLimit,
      blockedCount: await blocked(),
      action: capacityAction({ mode: 'plan', planId: entitlement.planId }),
      resetDate: entitlement.periodEnd,
      dashboardUrl: this.dashboardUrl(),
    });
  }

  private async evaluateCredits(
    source: IntegrationRecord,
    blocked: () => Promise<number>,
  ): Promise<void> {
    const entitlement = await this.entitlements.readEntitlement({
      id: source.id,
      orgId: source.orgId,
    });
    const credits = 'credits' in entitlement ? entitlement.credits : undefined;
    if (!credits || credits.status !== 'active') return;
    const threshold = readStandaloneCreditBillingConfig(
      this.config,
    ).lowBalanceThreshold;
    await this.alerts.resolveOpenCreditAlerts(
      source.orgId,
      recoveredCreditLevels(credits.availableCredits, threshold),
    );
    const alert = await this.claimHighest(
      source,
      'credit_balance',
      creditAlertLevels(credits.availableCredits, threshold),
      CREDIT_ALERT_CYCLE_KEY,
    );
    if (!alert) return;
    await this.deliver(alert, source, {
      level: alert.level,
      storeName: source.storeName ?? null,
      availableCredits: credits.availableCredits,
      blockedCount: await blocked(),
      action: 'recharge',
      resetDate: null,
      dashboardUrl: this.dashboardUrl(),
    });
  }

  /**
   * Records every reached level and returns the highest one this call newly
   * recorded, which is the one emailed. Lower levels recorded with it (a jump
   * from 79% to 100%) are marked skipped so they never fire later.
   */
  private async claimHighest(
    source: IntegrationRecord,
    kind: UsageAlertKind,
    levels: UsageAlertLevel[],
    cycleKey: string,
  ): Promise<ClaimedAlert | null> {
    const claimed: ClaimedAlert[] = [];
    for (const level of levels) {
      const id = await this.alerts.claim({
        orgId: source.orgId,
        integrationId: source.id,
        kind,
        level,
        cycleKey,
      });
      if (id) claimed.push({ id, level });
    }
    const highest = claimed.at(-1) ?? null;
    for (const lower of claimed.slice(0, -1)) {
      await this.alerts.markEmail(lower.id, 'skipped', 'superseded');
    }
    return highest;
  }

  private async deliver(
    alert: ClaimedAlert,
    source: IntegrationRecord,
    facts: UsageAlertFacts,
  ): Promise<void> {
    // A store that reported its own email (Shopify's shop email) is written
    // to there; otherwise the owner's sign-in email, which a store-created
    // user does not have.
    const recipient =
      source.notificationEmail?.trim() ||
      (await this.alerts.findOwnerEmail(source.orgId));
    if (!recipient) {
      await this.alerts.markEmail(alert.id, 'skipped', 'no_recipient');
      this.log(alert, source, 'skipped', 'no_recipient');
      return;
    }
    const message = buildUsageAlertEmail(
      usageAlertLanguage(source.defaultLanguage),
      facts,
    );
    const result = await this.email.send({
      to: recipient,
      ...message,
      idempotencyKey: `usage-alert-${alert.id}`,
    });
    if (result.status === 'sent') {
      await this.alerts.markEmail(alert.id, 'sent');
      this.log(alert, source, 'success');
      return;
    }
    await this.alerts.markEmail(alert.id, result.status, result.reason);
    this.log(
      alert,
      source,
      result.status === 'skipped' ? 'skipped' : 'failure',
      result.reason,
    );
  }

  private dashboardUrl(): string | null {
    return readUsageAlertsConfig(this.config).dashboardUrl;
  }

  private log(
    alert: ClaimedAlert,
    source: IntegrationRecord,
    outcome: 'success' | 'skipped' | 'failure',
    reason?: string,
  ): void {
    this.logger.log(
      buildBackendLog(UsageAlertService.name, {
        action: 'usage-alert-email',
        outcome,
        orgId: source.orgId,
        integrationId: source.id,
        alertId: alert.id,
        level: alert.level,
        ...(reason ? { reason } : {}),
      }),
    );
  }
}
