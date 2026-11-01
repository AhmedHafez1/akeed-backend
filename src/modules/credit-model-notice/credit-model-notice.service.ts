import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { CreditModelNoticesRepository } from '../../infrastructure/database/repositories/credit-model-notices.repository';
import { UsageAlertsRepository } from '../../infrastructure/database/repositories/usage-alerts.repository';
import { usesPrepaidCredits } from '../../shared/billing/credit-eligibility';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { buildCreditModelNoticeEmail } from '../../shared/notifications/credit-model-notice-copy';
import { usageAlertLanguage } from '../../shared/notifications/usage-alert-copy';
import { EMAIL_PORT, type EmailPort } from '../../shared/ports/email.port';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  assertOrganizationWriteAllowed,
  canWriteOrganization,
} from '../auth/organization-role';
import { CREDIT_MODEL_NOTICE_BATCH } from './credit-model-notice.constants';

export interface CreditModelNoticeDto {
  visible: boolean;
  canDismiss: boolean;
}

/** Tells existing prepaid merchants their balance number doubled at equal value. */
@Injectable()
export class CreditModelNoticeService {
  private readonly logger = new Logger(CreditModelNoticeService.name);

  constructor(
    private readonly notices: CreditModelNoticesRepository,
    private readonly integrations: IntegrationsRepository,
    private readonly alerts: UsageAlertsRepository,
    private readonly config: ConfigService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  async read(user: AuthenticatedUser): Promise<CreditModelNoticeDto> {
    return {
      visible: await this.notices.isVisible(user.orgId),
      canDismiss: Boolean(user.role && canWriteOrganization(user.role)),
    };
  }

  async dismiss(user: AuthenticatedUser): Promise<void> {
    assertOrganizationWriteAllowed(user.role, {
      code: 'CREDIT_MODEL_NOTICE_ROLE_REQUIRED',
      message: 'This account cannot dismiss the notice.',
    });
    await this.notices.dismiss(user.orgId);
  }

  /** One batch. Does nothing unless the owner has switched the email on. */
  async sendEmailBatch(): Promise<number> {
    const config = readUsageAlertsConfig(this.config);
    if (!config.creditModelNoticeEmailEnabled) return 0;
    const orgIds = await this.notices.claimEmailBatch(
      CREDIT_MODEL_NOTICE_BATCH,
    );
    for (const orgId of orgIds) {
      await this.sendOne(orgId, config.dashboardUrl);
    }
    return orgIds.length;
  }

  private async sendOne(
    orgId: string,
    dashboardUrl: string | null,
  ): Promise<void> {
    try {
      const sources = await this.integrations.findActiveByOrg(orgId);
      const source = sources.find((candidate) => usesPrepaidCredits(candidate));
      if (!source) {
        await this.notices.markEmail(orgId, 'skipped', 'no_prepaid_source');
        return;
      }
      const recipient =
        source.notificationEmail?.trim() ||
        (await this.alerts.findOwnerEmail(orgId));
      if (!recipient) {
        await this.notices.markEmail(orgId, 'skipped', 'no_recipient');
        return;
      }
      const result = await this.email.send({
        to: recipient,
        ...buildCreditModelNoticeEmail(
          usageAlertLanguage(source.defaultLanguage),
          { storeName: source.storeName ?? null, dashboardUrl },
        ),
        idempotencyKey: `credit-model-notice-${orgId}`,
      });
      await this.notices.markEmail(
        orgId,
        result.status,
        result.status === 'sent' ? undefined : result.reason,
      );
      this.logger.log(
        buildBackendLog(CreditModelNoticeService.name, {
          action: 'credit-model-notice-email',
          outcome: result.status === 'sent' ? 'success' : 'skipped',
          orgId,
          status: result.status,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(CreditModelNoticeService.name, {
          action: 'credit-model-notice-email',
          outcome: 'failure',
          orgId,
          ...normalizeError(error),
        }),
      );
      await this.notices.markEmail(orgId, 'failed', 'send_threw');
    }
  }
}
