import {
  WHATSAPP_OWN_NUMBER_CONFIG,
  parseWhatsappOwnNumberConfig,
} from '../../shared/config/whatsapp-own-number.config';
import { ConfigService } from '@nestjs/config';
import { SenderAlertService } from './sender-alert.service';
import {
  parseUsageAlertsConfig,
  USAGE_ALERTS_CONFIG,
} from '../../shared/config/usage-alerts.config';
import type { SenderAlert } from '../../shared/notifications/sender-alert.policy';

const alert: SenderAlert = {
  kind: 'payment',
  reason: 'payment',
  action: 'whatsapp_manager',
  severity: 'critical',
  templates: [],
};
function setup(enabled = true) {
  const repo = {
    read: jest.fn().mockResolvedValue([alert]),
    reconcile: jest.fn().mockResolvedValue([{ id: 'incident' }]),
    claimEmail: jest.fn().mockResolvedValue(alert),
    markEmail: jest.fn().mockResolvedValue(undefined),
  };
  const integrations = {
    findActiveByOrg: jest
      .fn()
      .mockResolvedValue([
        { notificationEmail: ' shop@example.test ', defaultLanguage: 'fr' },
      ]),
  };
  const owners = {
    findOwnerEmail: jest.fn().mockResolvedValue('owner@example.test'),
  };
  const email = { send: jest.fn().mockResolvedValue({ status: 'sent' }) };
  const config = new ConfigService({
    [WHATSAPP_OWN_NUMBER_CONFIG]: parseWhatsappOwnNumberConfig({}),
    [USAGE_ALERTS_CONFIG]: parseUsageAlertsConfig(
      enabled
        ? {
            EMAIL_ALERTS_ENABLED: 'true',
            RESEND_API_KEY: 'synthetic',
            EMAIL_FROM: 'test@example.test',
          }
        : {},
    ),
  });
  const service = new SenderAlertService(
    repo as never,
    integrations as never,
    owners as never,
    config,
    email,
  );
  return { repo, integrations, owners, email, service };
}
describe('sender alert delivery', () => {
  it('uses source email, source language and stable idempotency', async () => {
    const s = setup();
    await s.service.evaluate('org', 2);
    expect(s.repo.reconcile).toHaveBeenCalledWith('org', false, 2);
    expect(s.owners.findOwnerEmail).not.toHaveBeenCalled();
    expect(s.email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'shop@example.test',
        idempotencyKey: 'sender-alert-incident',
        subject: 'Votre moyen de paiement WhatsApp nécessite votre attention',
      }),
    );
    expect(s.repo.markEmail).toHaveBeenCalledWith(
      'org',
      'incident',
      'sent',
      undefined,
    );
  });
  it('uses the owner for Shopify placeholders or missing source emails', async () => {
    const s = setup();
    s.integrations.findActiveByOrg.mockResolvedValue([
      {
        notificationEmail: 'SHOP@AKEED-SHOPIFY.INTERNAL',
        defaultLanguage: 'auto',
      },
    ]);
    await s.service.evaluate('org');
    expect(s.email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.test',
        subject: 'وسيلة الدفع في واتساب تحتاج إلى مراجعة',
      }),
    );
  });
  it.each(['email_disabled', 'no_recipient'])(
    'records %s without calling email',
    async (reason) => {
      const s = setup(reason !== 'email_disabled');
      if (reason === 'no_recipient') {
        s.integrations.findActiveByOrg.mockResolvedValue([]);
        s.owners.findOwnerEmail.mockResolvedValue(null);
      }
      s.repo.claimEmail.mockResolvedValue(null);
      await s.service.evaluate('org');
      expect(s.repo.claimEmail).toHaveBeenCalledWith(
        'org',
        'incident',
        false,
        reason,
      );
      expect(s.email.send).not.toHaveBeenCalled();
      await expect(s.service.read('org')).resolves.toEqual([alert]);
      expect(s.repo.read).toHaveBeenCalledWith('org', false);
    },
  );
  it('does not email a stale, recovered, suppressed or previously claimed incident', async () => {
    const s = setup();
    s.repo.claimEmail.mockResolvedValue(null);
    await s.service.evaluate('org');
    expect(s.email.send).not.toHaveBeenCalled();
  });
  it('records provider failure and contains thrown exceptions', async () => {
    const s = setup();
    s.email.send.mockResolvedValue({
      status: 'failed',
      reason: 'provider_unreachable',
    });
    await s.service.evaluate('org');
    expect(s.repo.markEmail).toHaveBeenCalledWith(
      'org',
      'incident',
      'failed',
      'provider_unreachable',
    );
    s.email.send.mockRejectedValue(new Error('synthetic exception'));
    await expect(s.service.evaluate('org')).resolves.toBeUndefined();
    expect(s.repo.markEmail).toHaveBeenCalledWith(
      'org',
      'incident',
      'failed',
      'delivery_exception',
    );
    s.repo.reconcile.mockRejectedValue(new Error('database unavailable'));
    await expect(s.service.evaluate('org')).resolves.toBeUndefined();
  });
});
