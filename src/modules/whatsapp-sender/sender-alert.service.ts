import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappSenderAlertsRepository } from '../../infrastructure/database/repositories/whatsapp-sender-alerts.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { UsageAlertsRepository } from '../../infrastructure/database/repositories/usage-alerts.repository';
import { EMAIL_PORT, type EmailPort } from '../../shared/ports/email.port';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import { readWhatsappOwnNumberConfig } from '../../shared/config/whatsapp-own-number.config';
import { buildSenderAlertEmail } from '../../shared/notifications/sender-alert-copy';
import { usageAlertLanguage } from '../../shared/notifications/usage-alert-copy';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

@Injectable()
export class SenderAlertService {
  private readonly logger = new Logger(SenderAlertService.name);
  constructor(
    private readonly alerts: WhatsappSenderAlertsRepository,
    private readonly integrations: IntegrationsRepository,
    private readonly owners: UsageAlertsRepository,
    private readonly config: ConfigService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  read(orgId: string) {
    return this.alerts.read(
      orgId,
      readWhatsappOwnNumberConfig(this.config).sendingEnabled,
    );
  }

  /** Background only. A terminal delivery claim is never retried, even after a crash. */
  async evaluate(orgId: string, generation?: number): Promise<void> {
    try {
      const enabled = readWhatsappOwnNumberConfig(this.config).sendingEnabled;
      const pending = await this.alerts.reconcile(orgId, enabled, generation);
      if (!pending.length) return;
      const settings = readUsageAlertsConfig(this.config);
      const [source] = settings.emailEnabled
        ? await this.integrations.findActiveByOrg(orgId)
        : [];
      const reported = source?.notificationEmail?.trim();
      const recipient = !settings.emailEnabled
        ? null
        : reported &&
            !reported.toLowerCase().endsWith('@akeed-shopify.internal')
          ? reported
          : await this.owners.findOwnerEmail(orgId);
      for (const incident of pending) {
        const alert = await this.alerts.claimEmail(
          orgId,
          incident.id,
          enabled,
          !settings.emailEnabled
            ? 'email_disabled'
            : !recipient
              ? 'no_recipient'
              : undefined,
        );
        if (!alert || !recipient) continue;
        try {
          const result = await this.email.send({
            to: recipient,
            ...buildSenderAlertEmail(
              usageAlertLanguage(source?.defaultLanguage),
              alert,
              settings.dashboardUrl,
            ),
            idempotencyKey: `sender-alert-${incident.id}`,
          });
          await this.alerts.markEmail(
            orgId,
            incident.id,
            result.status,
            'reason' in result ? result.reason : undefined,
          );
        } catch (error) {
          await this.alerts.markEmail(
            orgId,
            incident.id,
            'failed',
            'delivery_exception',
          );
          this.log(orgId, error);
        }
      }
    } catch (error) {
      this.log(orgId, error);
    }
  }

  private log(orgId: string, error: unknown) {
    this.logger.warn(
      buildBackendLog(SenderAlertService.name, {
        action: 'sender-alert-evaluate',
        outcome: 'failure',
        orgId,
        ...normalizeError(error),
      }),
    );
  }
}
