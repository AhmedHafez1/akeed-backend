import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { boundedCall, NO_RETRY } from '../../../shared/http/bounded-http';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import { readUsageAlertsConfig } from '../../../shared/config/usage-alerts.config';
import type {
  EmailMessage,
  EmailPort,
  EmailSendResult,
} from '../../../shared/ports/email.port';

export const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_DEADLINE_MS = 10_000;

export const RESEND_HTTP = Symbol('RESEND_HTTP');
export type ResendHttp = typeof fetch;

/**
 * Sends merchant email through Resend. Sent once and never retried here: a
 * timed-out request may still have been delivered, so the caller records the
 * failure instead of sending again. The idempotency key lets Resend drop a
 * repeat if one is ever made.
 *
 * With `EMAIL_ALERTS_ENABLED` off nothing leaves the app and the result is
 * `skipped`.
 */
@Injectable()
export class ResendEmailAdapter implements EmailPort {
  private readonly logger = new Logger(ResendEmailAdapter.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(RESEND_HTTP) private readonly http: ResendHttp = fetch,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const settings = readUsageAlertsConfig(this.config);
    if (
      !settings.emailEnabled ||
      !settings.resendApiKey ||
      !settings.emailFrom
    ) {
      return { status: 'skipped', reason: 'email_disabled' };
    }
    try {
      const response = await boundedCall(
        () =>
          this.http(RESEND_API_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${settings.resendApiKey}`,
              'Content-Type': 'application/json',
              ...(message.idempotencyKey
                ? { 'Idempotency-Key': message.idempotencyKey }
                : {}),
            },
            body: JSON.stringify({
              from: settings.emailFrom,
              to: [message.to],
              subject: message.subject,
              text: message.text,
              html: message.html,
            }),
            signal: AbortSignal.timeout(SEND_DEADLINE_MS),
          }),
        { policy: NO_RETRY },
      );
      if (response.ok) return { status: 'sent' };
      const reason = `provider_status_${response.status}`;
      this.logger.warn(
        buildBackendLog(ResendEmailAdapter.name, {
          action: 'email-send',
          outcome: 'failure',
          errorCode: reason,
        }),
      );
      return { status: 'failed', reason };
    } catch (error) {
      this.logger.warn(
        buildBackendLog(ResendEmailAdapter.name, {
          action: 'email-send',
          outcome: 'failure',
          errorCode: 'provider_unreachable',
          ...normalizeError(error),
        }),
      );
      return { status: 'failed', reason: 'provider_unreachable' };
    }
  }
}
