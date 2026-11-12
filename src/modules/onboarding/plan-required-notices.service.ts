import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlanRequiredNoticesRepository,
  type PlanRequiredNotice,
} from '../../infrastructure/database/repositories/plan-required-notices.repository';
import {
  EMAIL_PORT,
  type EmailPort,
  type EmailSendResult,
} from '../../shared/ports/email.port';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  buildPlanRequiredEmail,
  planSelectionLink,
} from '../../shared/notifications/plan-required-email';
import { usageAlertLanguage } from '../../shared/notifications/usage-alert-copy';
import { usableNotificationEmail } from '../../shared/notifications/change-request-email';
import {
  effectiveBillingStatus,
  isBillingStatusActive,
} from '../../shared/utils/billing.util';
import { isBillingPlanId } from '../../shared/billing/billing-plan';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';

export const PLAN_NOTICE_REPLAY_WINDOW_MS = 24 * 3_600_000 - 60_000;

@Injectable()
export class PlanRequiredNoticesService {
  private readonly logger = new Logger(PlanRequiredNoticesService.name);
  constructor(
    private readonly notices: PlanRequiredNoticesRepository,
    private readonly config: ConfigService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  async drain(): Promise<void> {
    for (let count = 0; count < 25; count++) {
      const notice = await this.notices.claim();
      if (!notice) return;
      try {
        await this.deliver(notice);
      } catch {
        await this.retry(notice, 'notice_processing_failed');
      }
    }
  }

  private async deliver(notice: PlanRequiredNotice) {
    const context = await this.notices.context(notice);
    const source = context?.source;
    if (
      !source ||
      source.platformType !== 'shopify' ||
      !source.isActive ||
      context.uninstalledAt ||
      isBillingStatusActive(source.billingStatus, source.paidThroughAt)
    ) {
      await this.notices.settle(notice, 'skipped', 'no_longer_required');
      return;
    }
    if (
      notice.firstAttemptAt &&
      Date.now() - Date.parse(notice.firstAttemptAt) >=
        PLAN_NOTICE_REPLAY_WINDOW_MS
    ) {
      await this.notices.settle(notice, 'failed', 'email_outcome_unresolved');
      return;
    }
    let payload = notice.emailPayload;
    if (!payload) {
      const settings = readUsageAlertsConfig(this.config);
      if (!settings.emailEnabled) {
        await this.notices.settle(notice, 'skipped', 'email_disabled');
        return;
      }
      const recipient = usableNotificationEmail(source.notificationEmail);
      if (!recipient) {
        await this.notices.settle(notice, 'failed', 'no_recipient');
        return;
      }
      const language = usageAlertLanguage(source.defaultLanguage);
      const link = planSelectionLink(
        source.platformStoreUrl,
        language,
        this.config.get<string>('SHOPIFY_API_KEY'),
      );
      if (!link) {
        await this.notices.settle(notice, 'failed', 'plan_link_unavailable');
        return;
      }
      const lastPlan =
        source.billingPlanId && isBillingPlanId(source.billingPlanId)
          ? source.billingPlanId
          : null;
      const status = effectiveBillingStatus(
        source.billingStatus,
        source.paidThroughAt,
      );
      payload = {
        to: recipient,
        from: settings.emailFrom ?? undefined,
        idempotencyKey: `plan-required-${notice.lifecycleId}`,
        ...buildPlanRequiredEmail(language, {
          link,
          previousPlan: lastPlan,
          cancelled: ['cancelled', 'canceled'].includes(status ?? ''),
        }),
      };
      if (!(await this.notices.prepare(notice, payload))) return;
    }
    let result: EmailSendResult;
    try {
      result = await this.email.send(payload);
    } catch {
      result = {
        status: 'failed',
        reason: 'provider_outcome_unknown',
        retryable: true,
        uncertain: true,
      };
    }
    if (result.status === 'failed' && result.retryable)
      await this.retry(notice, result.reason);
    else
      await this.notices.settle(
        notice,
        result.status,
        'reason' in result ? result.reason : null,
      );
  }

  private async retry(notice: PlanRequiredNotice, reason: string) {
    const exhausted = notice.attempts >= DEFAULT_QUEUE_JOB_OPTIONS.attempts;
    await this.notices.settle(
      notice,
      exhausted ? 'failed' : 'pending',
      reason,
      DEFAULT_QUEUE_JOB_OPTIONS.backoff.delay * 2 ** (notice.attempts - 1),
    );
    this.logger.warn(
      buildBackendLog(PlanRequiredNoticesService.name, {
        action: 'plan-required-email',
        outcome: exhausted ? 'failure' : 'retry',
        orgId: notice.orgId,
        integrationId: notice.integrationId,
        reason,
      }),
    );
  }
}
