import {
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AnnouncementEmailsRepository,
  type AnnouncementDelivery,
} from '../../infrastructure/database/repositories/announcement-emails.repository';
import { TipsCampaignsRepository } from '../../infrastructure/database/repositories/tips-campaigns.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { UsageAlertsRepository } from '../../infrastructure/database/repositories/usage-alerts.repository';
import { readAnnouncementEmailConfig } from '../../shared/config/announcement-email.config';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import { readStandaloneCreditBillingConfig } from '../../shared/config/standalone-credit-billing.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { usageAlertLanguage } from '../../shared/notifications/usage-alert-copy';
import { usableNotificationEmail } from '../../shared/notifications/change-request-email';
import { whatsappSettingsLink } from '../../shared/notifications/whatsapp-settings-link';
import { EMAIL_PORT, type EmailPort } from '../../shared/ports/email.port';
import {
  announcementIssues,
  announcementPlanLine,
  renderAnnouncement,
  type AnnouncementEmail,
} from '../../shared/tips-campaigns/announcement-email.policy';
import { announcementUnsubscribeToken } from '../../shared/tips-campaigns/announcement-unsubscribe';
import type { InterfaceLocale } from '../../shared/i18n/interface-locales';
import { isBillingStatusActive } from '../../shared/utils/billing.util';

export const ANNOUNCEMENT_SAMPLES = [
  'starter',
  'basic',
  'pro',
  'business',
  'prepaid',
] as const;
export type AnnouncementSample = (typeof ANNOUNCEMENT_SAMPLES)[number];

@Injectable()
export class AnnouncementEmailService {
  private readonly logger = new Logger(AnnouncementEmailService.name);
  constructor(
    readonly deliveries: AnnouncementEmailsRepository,
    private readonly campaigns: TipsCampaignsRepository,
    private readonly integrations: IntegrationsRepository,
    private readonly owners: UsageAlertsRepository,
    private readonly config: ConfigService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  enabled(): boolean {
    return (
      readAnnouncementEmailConfig(this.config).enabled &&
      readUsageAlertsConfig(this.config).emailEnabled
    );
  }

  preview(
    email: AnnouncementEmail,
    locale: InterfaceLocale,
    sample: AnnouncementSample,
  ) {
    const issues = announcementIssues(email, true);
    if (issues.length)
      throw new UnprocessableEntityException({
        code: 'TIPS_CAMPAIGN_INVALID',
        message: 'Correct the email content.',
        issues,
      });
    const language = email.translations.some((t) => t.locale === locale)
      ? locale
      : 'en';
    const price = readStandaloneCreditBillingConfig(this.config).priceMinor;
    return {
      locale: language,
      sample,
      ...renderAnnouncement(
        email,
        language,
        {
          storeName: 'Noor Store',
          planLine: announcementPlanLine(
            language,
            {
              platformType: sample === 'prepaid' ? 'standalone' : 'shopify',
              billingPlanId: sample === 'prepaid' ? null : sample,
            },
            price,
          ),
          dashboardLink: whatsappSettingsLink({
            language,
            platformType: sample === 'prepaid' ? 'standalone' : 'shopify',
            platformStoreUrl: 'noor.myshopify.com',
            dashboardUrl: 'https://getakeed.com',
            shopifyApiKey: 'synthetic-app',
          }),
          guideLink: `https://getakeed.com/${language}/docs/own-whatsapp-number`,
        },
        'https://getakeed.com/announcement-unsubscribe-preview',
      ),
    };
  }

  async sendBatch(): Promise<number> {
    if (!this.enabled()) return 0;
    const settings = readAnnouncementEmailConfig(this.config);
    const sweepToken = await this.deliveries.claimSweep(settings.intervalMs);
    if (!sweepToken) return 0;
    let claimed = 0;
    try {
      for (; claimed < settings.batchSize && this.enabled(); claimed++) {
        const row = await this.deliveries.claimNext(sweepToken);
        if (!row) break;
        try {
          await this.sendOne(row);
        } catch {
          // The fenced lease, saved envelope and write-ahead attempt survive.
          this.logger.error(
            buildBackendLog(AnnouncementEmailService.name, {
              action: 'announcement-email',
              outcome: 'failure',
              campaignId: row.campaignId,
              orgId: row.orgId,
              errorCode: 'delivery_processing_failed',
            }),
          );
        }
      }
    } finally {
      await this.deliveries.finishSweep(sweepToken);
    }
    return claimed;
  }

  private async sendOne(row: AnnouncementDelivery): Promise<void> {
    const reason = await this.deliveries.skipReason(row);
    if (reason) {
      await this.deliveries.skip(row, reason);
      return;
    }
    let prepared = row;
    if (!row.emailPayload) {
      const detail = await this.campaigns.findById(row.campaignId);
      const content = detail?.campaign.announcementEmail;
      if (!content || detail.campaign.emailStoppedAt) {
        await this.deliveries.skip(row, 'stopped');
        return;
      }
      const sources = await this.integrations.findActiveByOrg(row.orgId);
      const source = sources[0];
      if (!source) {
        await this.deliveries.skip(row, 'inactive');
        return;
      }
      const recipient =
        usableNotificationEmail(source.notificationEmail) ??
        usableNotificationEmail(await this.owners.findOwnerEmail(row.orgId));
      if (!recipient) {
        await this.deliveries.skip(row, 'no_recipient');
        return;
      }
      const requested = usageAlertLanguage(source.defaultLanguage);
      const locale = content.translations.some((t) => t.locale === requested)
        ? requested
        : 'en';
      const transport = readUsageAlertsConfig(this.config);
      const settings = readAnnouncementEmailConfig(this.config);
      if (
        !settings.publicApiUrl ||
        !settings.unsubscribeSecret ||
        !transport.dashboardUrl ||
        !transport.emailFrom ||
        !this.enabled()
      )
        return;
      const token = announcementUnsubscribeToken(
        row.orgId,
        locale,
        settings.unsubscribeSecret,
      );
      const unsubscribeUrl = new URL(
        `/api/announcements/unsubscribe?token=${token}`,
        settings.publicApiUrl,
      ).toString();
      const dashboardLink = whatsappSettingsLink({
        language: locale,
        platformType: source.platformType,
        platformStoreUrl: source.platformStoreUrl,
        dashboardUrl: transport.dashboardUrl,
        shopifyApiKey: this.config.get<string>('SHOPIFY_API_KEY'),
      });
      const message = renderAnnouncement(
        content,
        locale,
        {
          storeName: source.storeName?.trim() || null,
          planLine:
            source.platformType === 'shopify' &&
            !isBillingStatusActive(source.billingStatus, source.paidThroughAt)
              ? null
              : announcementPlanLine(
                  locale,
                  source,
                  readStandaloneCreditBillingConfig(this.config).priceMinor,
                ),
          dashboardLink,
          guideLink: new URL(
            `/${locale}/docs/own-whatsapp-number`,
            transport.dashboardUrl,
          ).toString(),
        },
        unsubscribeUrl,
      );
      if ('missing' in message) {
        await this.deliveries.skip(row, `missing_${message.missing}`);
        return;
      }
      const saved = await this.deliveries.prepare(row, {
        ...message,
        to: recipient,
        from: transport.emailFrom,
        replyTo:
          transport.emailFrom.match(/<([^>]+)>/)?.[1] ?? transport.emailFrom,
        idempotencyKey: `announcement-${row.campaignId}-${row.orgId}`,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      if (!saved) return;
      prepared = saved;
    }
    const attempt = await this.deliveries.startAttempt(prepared);
    if (!attempt) {
      await this.deliveries.fail(prepared, 'provider_outcome_unresolved');
      return;
    }
    await this.deliveries.dispatch(
      attempt,
      () => this.enabled(),
      (message) => this.email.send(message),
    );
  }
}
