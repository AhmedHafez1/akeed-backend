import type { ConfigService } from '@nestjs/config';
import {
  parseUsageAlertsConfig,
  USAGE_ALERTS_CONFIG,
} from '../../../shared/config/usage-alerts.config';
import type { EmailMessage } from '../../../shared/ports/email.port';
import { ResendEmailAdapter, type ResendHttp } from './resend-email.adapter';

const MESSAGE: EmailMessage = {
  to: 'owner@example.test',
  subject: 'Akeed has paused order confirmations',
  text: 'Hello',
  html: '<p>Hello</p>',
  idempotencyKey: 'usage-alert-1',
};

function adapter(env: Record<string, unknown>, http: jest.Mock) {
  const settings = parseUsageAlertsConfig(env);
  const config = {
    get: (key: string) => (key === USAGE_ALERTS_CONFIG ? settings : undefined),
  } as unknown as ConfigService;
  return new ResendEmailAdapter(config, http as unknown as ResendHttp);
}

const ENABLED = {
  EMAIL_ALERTS_ENABLED: 'true',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'alerts@example.test',
};

describe('ResendEmailAdapter', () => {
  it('sends nothing while email alerts are off', async () => {
    const http = jest.fn();

    await expect(adapter({}, http).send(MESSAGE)).resolves.toEqual({
      status: 'skipped',
      reason: 'email_disabled',
    });
    expect(http).not.toHaveBeenCalled();
  });

  it('posts the message once with the idempotency key', async () => {
    const http = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await expect(adapter(ENABLED, http).send(MESSAGE)).resolves.toEqual({
      status: 'sent',
    });
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test',
      'Idempotency-Key': 'usage-alert-1',
    });
    expect(JSON.parse(init.body)).toEqual({
      from: 'alerts@example.test',
      to: ['owner@example.test'],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it('reports a refusal by status without retrying', async () => {
    const http = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    await expect(adapter(ENABLED, http).send(MESSAGE)).resolves.toEqual({
      status: 'failed',
      reason: 'provider_status_503',
    });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('reports an unreachable provider without throwing', async () => {
    const http = jest.fn().mockRejectedValue(new Error('socket hang up'));

    await expect(adapter(ENABLED, http).send(MESSAGE)).resolves.toEqual({
      status: 'failed',
      reason: 'provider_unreachable',
    });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
