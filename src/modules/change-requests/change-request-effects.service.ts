import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  VerificationChangeRequestsRepository,
  type ChangeRequestEffectRow,
} from '../../infrastructure/database/repositories/verification-change-requests.repository';
import { UsageAlertsRepository } from '../../infrastructure/database/repositories/usage-alerts.repository';
import {
  EMAIL_PORT,
  type EmailPort,
  type EmailSendResult,
} from '../../shared/ports/email.port';
import { readUsageAlertsConfig } from '../../shared/config/usage-alerts.config';
import { usageAlertLanguage } from '../../shared/notifications/usage-alert-copy';
import {
  buildChangeRequestEmail,
  changeRequestDashboardLink,
  usableNotificationEmail,
} from '../../shared/notifications/change-request-email';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import { VerificationAutomationProducer } from '../verification-automation/verification-automation.producer';
import { DEFAULT_QUEUE_JOB_OPTIONS } from '../../shared/queue/job-options';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';

const LEASE_MS = 120_000;
// Leave a margin for a request reaching the provider near key expiration.
export const EMAIL_REPLAY_WINDOW_MS = 24 * 3_600_000 - 60_000;

@Injectable()
export class ChangeRequestEffectsService {
  private readonly logger = new Logger(ChangeRequestEffectsService.name);
  constructor(
    private readonly requests: VerificationChangeRequestsRepository,
    private readonly owners: UsageAlertsRepository,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    private readonly config: ConfigService,
    private readonly commerce: CommerceOutcomeRegistryService,
    private readonly automation: VerificationAutomationProducer,
  ) {}

  async drain(changeRequestId?: string, orgId?: string): Promise<void> {
    for (const kind of [
      'merchant_email',
      'platform_marker_set',
      'platform_marker_clear',
    ] as const) {
      for (let count = 0; count < (changeRequestId ? 1 : 25); count++) {
        const effect = await this.requests.claimEffect(
          kind,
          LEASE_MS,
          new Date(),
          changeRequestId,
          orgId,
        );
        if (!effect) break;
        try {
          if (kind === 'merchant_email') await this.sendEmail(effect);
          else await this.reconcilePlatform(effect);
        } catch (error) {
          this.logger.warn(
            buildBackendLog(ChangeRequestEffectsService.name, {
              action: 'change-request-effect',
              outcome: 'retry',
              orgId: effect.orgId,
              effectId: effect.id,
              ...normalizeError(error),
            }),
          );
          await this.retry(effect, 'effect_processing_failed');
        }
      }
    }
  }

  private async sendEmail(effect: ChangeRequestEffectRow): Promise<void> {
    if (
      effect.firstAttemptAt &&
      Date.now() - Date.parse(effect.firstAttemptAt) >= EMAIL_REPLAY_WINDOW_MS
    ) {
      await this.finish(effect, 'failed', 'email_outcome_unresolved');
      return;
    }
    let prepared = effect;
    if (!effect.emailPayload) {
      const request = await this.requests.findById(
        effect.changeRequestId,
        effect.orgId,
      );
      const context = request
        ? await this.requests.notificationContext(request)
        : null;
      if (!request || !context) {
        await this.finish(effect, 'failed', 'request_context_unavailable');
        return;
      }
      const settings = readUsageAlertsConfig(this.config);
      if (!settings.emailEnabled) {
        await this.finish(effect, 'skipped', 'email_disabled');
        return;
      }
      const recipient =
        usableNotificationEmail(context.notificationEmail) ??
        usableNotificationEmail(await this.owners.findOwnerEmail(effect.orgId));
      if (!recipient) {
        await this.finish(effect, 'failed', 'no_recipient');
        return;
      }
      const language = usageAlertLanguage(context.defaultLanguage);
      const link = changeRequestDashboardLink({
        ...context,
        language,
        verificationId: request.verificationId,
        dashboardUrl: settings.dashboardUrl,
        shopifyApiKey: this.config.get<string>('SHOPIFY_API_KEY'),
      });
      if (!link) {
        await this.finish(effect, 'failed', 'dashboard_link_unavailable');
        return;
      }
      const payload = {
        to: recipient,
        from: settings.emailFrom ?? undefined,
        idempotencyKey: `change-request-${request.id}-initial`,
        ...buildChangeRequestEmail(language, {
          store:
            context.storeName?.trim() ||
            context.organizationName?.trim() ||
            context.platformStoreUrl,
          order: context.orderNumber || context.externalOrderId,
          source: context.platformType,
          openedAt: request.openedAt,
          timezone: context.timezone,
          link,
        }),
      };
      const saved = await this.requests.prepareEmail(effect, payload);
      if (!saved) return; // A newer claim owns the row.
      prepared = saved;
    }
    let result: EmailSendResult;
    try {
      result = await this.email.send(prepared.emailPayload!);
    } catch {
      result = {
        status: 'failed',
        reason: 'provider_outcome_unknown',
        retryable: true,
        uncertain: true,
      };
    }
    if (result.status === 'sent') await this.finish(effect, 'done');
    else if (result.status === 'failed' && result.retryable)
      await this.retry(effect, result.reason);
    else
      await this.finish(
        effect,
        result.status === 'skipped' ? 'skipped' : 'failed',
        result.reason,
      );
  }

  private async reconcilePlatform(
    effect: ChangeRequestEffectRow,
  ): Promise<void> {
    const request = await this.requests.findById(
      effect.changeRequestId,
      effect.orgId,
    );
    const context = request
      ? await this.requests.notificationContext(request)
      : null;
    if (!request || !context) {
      await this.finish(effect, 'failed', 'request_context_unavailable');
      return;
    }
    const result = await this.commerce.dispatch({
      orgId: effect.orgId,
      integrationId: request.integrationId,
      externalOrderId: context.externalOrderId,
      correlationId: request.verificationId,
      action: 'change_request_reconciliation',
      retryInBackground: true,
    });
    if (result.status === 'applied') await this.finish(effect, 'done');
    else if (result.status === 'unsupported')
      await this.finish(effect, 'skipped', result.reason);
    else if (result.status === 'retryable_failure')
      await this.retry(effect, result.errorCode, result.retryAfterMs);
    else
      await this.finish(
        effect,
        'failed',
        'errorCode' in result ? result.errorCode : 'platform_outcome_unknown',
      );
  }

  private async retry(
    effect: ChangeRequestEffectRow,
    reason: string,
    delayMs?: number,
  ): Promise<void> {
    if (effect.attempts >= DEFAULT_QUEUE_JOB_OPTIONS.attempts) {
      await this.finish(effect, 'failed', reason);
      return;
    }
    const dueAt = new Date(
      Date.now() +
        Math.max(
          delayMs ??
            DEFAULT_QUEUE_JOB_OPTIONS.backoff.delay *
              2 ** (effect.attempts - 1),
          1_000,
        ),
    );
    const settled = await this.requests.settleEffect({
      effectId: effect.id,
      attempts: effect.attempts,
      status: 'pending',
      reason,
      nextAttemptAt: dueAt.toISOString(),
    });
    if (settled) {
      // Failure to enqueue leaves the due outbox row for the existing recovery sweep.
      try {
        await this.automation.enqueueChangeRequestEffects({
          changeRequestId: effect.changeRequestId,
          orgId: effect.orgId,
          dueAt,
        });
      } catch (error) {
        this.logger.warn(
          buildBackendLog(ChangeRequestEffectsService.name, {
            action: 'change-request-effect-enqueue',
            outcome: 'retry',
            orgId: effect.orgId,
            ...normalizeError(error),
          }),
        );
      }
    }
  }

  private async finish(
    effect: ChangeRequestEffectRow,
    status: 'done' | 'failed' | 'skipped',
    reason?: string,
  ): Promise<void> {
    const settled = await this.requests.settleEffect({
      effectId: effect.id,
      attempts: effect.attempts,
      status,
      reason,
    });
    if (!settled) return;
    this.logger.log(
      buildBackendLog(ChangeRequestEffectsService.name, {
        action: 'change-request-effect',
        outcome:
          status === 'done'
            ? 'success'
            : status === 'failed'
              ? 'failure'
              : 'skipped',
        orgId: effect.orgId,
        effectId: effect.id,
        effectKind: effect.kind,
        reason,
      }),
    );
  }
}
