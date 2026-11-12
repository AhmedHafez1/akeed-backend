import { ConfigService } from '@nestjs/config';
import {
  PlanRequiredNoticesService,
  PLAN_NOTICE_REPLAY_WINDOW_MS,
} from './plan-required-notices.service';
import {
  parseUsageAlertsConfig,
  USAGE_ALERTS_CONFIG,
} from '../../shared/config/usage-alerts.config';
import type { PlanRequiredNotice } from '../../infrastructure/database/repositories/plan-required-notices.repository';
import type {
  EmailMessage,
  EmailSendResult,
} from '../../shared/ports/email.port';

function setup(overrides: Partial<PlanRequiredNotice> = {}) {
  const notice: PlanRequiredNotice = {
    id: 'notice',
    orgId: 'org',
    integrationId: 'source',
    lifecycleId: 'install',
    attempts: 1,
    firstAttemptAt: null,
    emailPayload: null,
    ...overrides,
  };
  const source = {
    platformType: 'shopify',
    platformStoreUrl: 'synthetic.myshopify.com',
    isActive: true,
    billingStatus: 'cancelled',
    billingPlanId: 'pro',
    paidThroughAt: null,
    defaultLanguage: 'ar',
    notificationEmail: 'merchant@example.test',
  };
  const repo = {
    claim: jest.fn().mockResolvedValueOnce(notice).mockResolvedValue(null),
    context: jest.fn().mockResolvedValue({ source, uninstalledAt: null }),
    prepare: jest.fn().mockResolvedValue(true),
    settle: jest.fn(),
  };
  const email = {
    send: jest
      .fn<Promise<EmailSendResult>, [EmailMessage]>()
      .mockResolvedValue({ status: 'sent' }),
  };
  const config = new ConfigService({
    [USAGE_ALERTS_CONFIG]: parseUsageAlertsConfig({
      EMAIL_ALERTS_ENABLED: 'true',
      RESEND_API_KEY: 'synthetic',
      EMAIL_FROM: 'alerts@example.test',
    }),
    SHOPIFY_API_KEY: 'synthetic-app',
  });
  return {
    notice,
    source,
    repo,
    email,
    service: new PlanRequiredNoticesService(repo as never, config, email),
  };
}
describe('plan-required email delivery', () => {
  it('does not send again after the notice was consumed', async () => {
    const { service, email } = setup();
    await service.drain();
    await service.drain();
    expect(email.send).toHaveBeenCalledTimes(1);
  });
  it('stops after the bounded retry budget', async () => {
    const { service, email, repo } = setup({ attempts: 5 });
    email.send.mockResolvedValue({
      status: 'failed',
      reason: 'provider_unreachable',
      retryable: true,
    });
    await service.drain();
    expect(repo.settle).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      'provider_unreachable',
      48000,
    );
  });
  it('does not send from a stale preparation claim', async () => {
    const { service, email, repo } = setup();
    repo.prepare.mockResolvedValue(false);
    await service.drain();
    expect(email.send).not.toHaveBeenCalled();
  });
  it('snapshots an Arabic email with an embedded Plan-tab link and stable install key', async () => {
    const { service, email, repo, notice } = setup();
    await service.drain();
    expect(email.send).toHaveBeenCalledTimes(1);
    const delivered = email.send.mock.calls[0][0];
    expect(delivered.to).toBe('merchant@example.test');
    expect(delivered.idempotencyKey).toBe('plan-required-install');
    expect(delivered.html).toContain('dir="rtl"');
    expect(delivered.text).toContain(
      '/admin/apps/synthetic-app/ar/settings?tab=plan',
    );
    expect(repo.settle).toHaveBeenCalledWith(notice, 'sent', null);
  });
  it('reuses the exact envelope after an uncertain delivery', async () => {
    const payload = {
      from: 'original@example.test',
      to: 'original-recipient@example.test',
      subject: 'Original',
      text: 'Original',
      html: '<p>Original</p>',
      idempotencyKey: 'original-key',
    };
    const { service, repo, email, source } = setup({
      attempts: 2,
      firstAttemptAt: new Date().toISOString(),
      emailPayload: payload,
    });
    source.notificationEmail = 'changed@example.test';
    email.send.mockResolvedValue({
      status: 'failed',
      retryable: true,
      uncertain: true,
      reason: 'provider_unreachable',
    });
    await service.drain();
    expect(email.send).toHaveBeenCalledWith(payload);
    expect(repo.prepare).not.toHaveBeenCalled();
    expect(repo.settle).toHaveBeenCalledWith(
      expect.anything(),
      'pending',
      'provider_unreachable',
      6000,
    );
  });
  it('never retries beyond the provider replay window', async () => {
    const { service, email, repo } = setup({
      firstAttemptAt: new Date(
        Date.now() - PLAN_NOTICE_REPLAY_WINDOW_MS - 1000,
      ).toISOString(),
    });
    await service.drain();
    expect(email.send).not.toHaveBeenCalled();
    expect(repo.settle).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      'email_outcome_unresolved',
    );
  });
  it.each(['active', 'paid_through'])(
    'cancels pending email once %s is entitled',
    async (status) => {
      const { service, source, email } = setup();
      source.billingStatus = status;
      source.paidThroughAt = '2099-01-01' as never;
      await service.drain();
      expect(email.send).not.toHaveBeenCalled();
    },
  );
  it.each(['standalone', 'easyorders', 'woocommerce'])(
    'never emails %s',
    async (platform) => {
      const { service, source, email } = setup();
      source.platformType = platform;
      await service.drain();
      expect(email.send).not.toHaveBeenCalled();
    },
  );
  it('does not deliver for an ended installation', async () => {
    const { service, repo, email } = setup();
    repo.context.mockResolvedValue({ source: {}, uninstalledAt: '2026-11-11' });
    await service.drain();
    expect(email.send).not.toHaveBeenCalled();
  });
  it('records missing notification email without falling back to another address', async () => {
    const { service, source, repo, email } = setup();
    source.notificationEmail = '';
    await service.drain();
    expect(email.send).not.toHaveBeenCalled();
    expect(repo.settle).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      'no_recipient',
    );
  });
});
