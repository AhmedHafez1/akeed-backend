/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { ConfigService } from '@nestjs/config';
import { AnnouncementEmailService } from './announcement-email.service';
import type {
  AnnouncementDelivery,
  AnnouncementEmailsRepository,
} from '../../infrastructure/database/repositories/announcement-emails.repository';
import type { TipsCampaignsRepository } from '../../infrastructure/database/repositories/tips-campaigns.repository';
import type { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import type { UsageAlertsRepository } from '../../infrastructure/database/repositories/usage-alerts.repository';
import { ANNOUNCEMENT_EMAIL_CONFIG } from '../../shared/config/announcement-email.config';
import { USAGE_ALERTS_CONFIG } from '../../shared/config/usage-alerts.config';
import { STANDALONE_CREDIT_BILLING_CONFIG } from '../../shared/config/standalone-credit-billing.config';
import type { EmailMessage } from '../../shared/ports/email.port';

const ORG = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
function setup() {
  const row = {
    orgId: ORG,
    campaignId: CAMPAIGN,
    status: 'processing',
    attempts: 0,
    emailPayload: null,
  } as AnnouncementDelivery;
  const deliveries = {
    claimSweep: jest.fn().mockResolvedValue('sweep'),
    claimNext: jest.fn().mockResolvedValueOnce(row).mockResolvedValue(null),
    finishSweep: jest.fn().mockResolvedValue(undefined),
    skipReason: jest.fn().mockResolvedValue(null),
    skip: jest.fn(),
    fail: jest.fn(),
    prepare: jest.fn((_row: AnnouncementDelivery, payload: EmailMessage) =>
      Promise.resolve({
        ...row,
        emailPayload: payload,
      }),
    ),
    startAttempt: jest.fn((prepared: AnnouncementDelivery) =>
      Promise.resolve({
        ...prepared,
        attempts: 1,
      }),
    ),
    dispatch: jest.fn(
      async (
        prepared: AnnouncementDelivery,
        enabled: () => boolean,
        send: (message: EmailMessage) => Promise<unknown>,
      ) => {
        if (enabled()) await send(prepared.emailPayload!);
      },
    ),
  };
  const campaigns = {
    findById: jest.fn().mockResolvedValue({
      campaign: {
        announcementEmail: {
          translations: [
            {
              locale: 'en',
              subject: 'Launch',
              body: 'Hello {storeName}\n{planLine}\n{dashboardLink}\n{guideLink}',
            },
          ],
        },
        emailStoppedAt: null,
      },
    }),
  };
  const source = {
    platformType: 'standalone',
    billingPlanId: 'starter',
    billingStatus: 'active',
    platformStoreUrl: 'synthetic.example.test',
    defaultLanguage: 'en',
    storeName: 'Noor',
    notificationEmail: 'store@example.test',
  };
  const integrations = {
    findActiveByOrg: jest.fn().mockResolvedValue([source]),
  };
  const owners = {
    findOwnerEmail: jest.fn().mockResolvedValue('owner@example.test'),
  };
  const settings = {
    enabled: true,
    batchSize: 50,
    intervalMs: 300000,
    publicApiUrl: 'https://api.example.test',
    unsubscribeSecret: 'synthetic-signing-secret-with-at-least-32-characters',
  };
  const config = {
    get: (key: string) =>
      key === ANNOUNCEMENT_EMAIL_CONFIG
        ? settings
        : key === USAGE_ALERTS_CONFIG
          ? {
              emailEnabled: true,
              dashboardUrl: 'https://getakeed.com',
              emailFrom: 'Akeed <hello@example.test>',
            }
          : key === STANDALONE_CREDIT_BILLING_CONFIG
            ? { priceMinor: 200 }
            : undefined,
  } as unknown as ConfigService;
  const send = jest.fn().mockResolvedValue({ status: 'sent' });
  const service = new AnnouncementEmailService(
    deliveries as unknown as AnnouncementEmailsRepository,
    campaigns as unknown as TipsCampaignsRepository,
    integrations as unknown as IntegrationsRepository,
    owners as unknown as UsageAlertsRepository,
    config,
    { send },
  );
  return {
    service,
    deliveries,
    campaigns,
    integrations,
    owners,
    send,
    settings,
    source,
    row,
  };
}
describe('announcement email worker', () => {
  it('does not promise an allowance for an inactive Shopify plan', async () => {
    const s = setup();
    s.source.platformType = 'shopify';
    s.source.billingStatus = 'cancelled';
    s.campaigns.findById.mockResolvedValue({
      campaign: {
        announcementEmail: {
          translations: [
            { locale: 'en', subject: 'Launch', body: '{planLine}' },
          ],
        },
        emailStoppedAt: null,
      },
    });
    await s.service.sendBatch();
    expect(s.deliveries.skip).toHaveBeenCalledWith(s.row, 'missing_planLine');
    expect(s.send).not.toHaveBeenCalled();
  });
  it('does not claim or send when the global switch is off', async () => {
    const s = setup();
    s.settings.enabled = false;
    expect(await s.service.sendBatch()).toBe(0);
    expect(s.deliveries.claimSweep).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });
  it('saves one personalized envelope with recipient fallback and required headers before sending', async () => {
    const s = setup();
    s.source.notificationEmail = '';
    expect(await s.service.sendBatch()).toBe(1);
    expect(s.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.test',
        replyTo: 'hello@example.test',
        idempotencyKey: `announcement-${CAMPAIGN}-${ORG}`,
        text: expect.stringContaining('1 credit'),
        headers: {
          'List-Unsubscribe': expect.stringContaining(
            '/api/announcements/unsubscribe?token=',
          ),
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    );
    expect(s.deliveries.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      s.send.mock.invocationCallOrder[0],
    );
  });
  it.each(['unsubscribed', 'stopped', 'inactive'])(
    'skips %s before preparing any recipient data',
    async (reason) => {
      const s = setup();
      s.deliveries.skipReason.mockResolvedValue(reason);
      await s.service.sendBatch();
      expect(s.deliveries.skip).toHaveBeenCalledWith(s.row, reason);
      expect(s.integrations.findActiveByOrg).not.toHaveBeenCalled();
      expect(s.send).not.toHaveBeenCalled();
    },
  );
  it('skips an organization without a recipient or a required placeholder', async () => {
    const s = setup();
    s.source.notificationEmail = '';
    s.owners.findOwnerEmail.mockResolvedValue(null);
    await s.service.sendBatch();
    expect(s.deliveries.skip).toHaveBeenCalledWith(s.row, 'no_recipient');
    expect(s.send).not.toHaveBeenCalled();
    const missing = setup();
    missing.source.storeName = '';
    await missing.service.sendBatch();
    expect(missing.deliveries.skip).toHaveBeenCalledWith(
      missing.row,
      'missing_storeName',
    );
    expect(missing.send).not.toHaveBeenCalled();
  });
  it('reuses a saved envelope after restart without reading changed merchant data', async () => {
    const s = setup();
    const payload = {
      to: 'frozen@example.test',
      subject: 'Frozen',
      text: 'Frozen',
      html: '<p>Frozen</p>',
      idempotencyKey: 'saved-key',
    };
    s.row.emailPayload = payload;
    await s.service.sendBatch();
    expect(s.send).toHaveBeenCalledWith(payload);
    expect(s.campaigns.findById).not.toHaveBeenCalled();
    expect(s.deliveries.prepare).not.toHaveBeenCalled();
  });
  it('does not call the provider when the retry budget or replay deadline is exhausted', async () => {
    const s = setup();
    s.row.emailPayload = {
      to: 'frozen@example.test',
      subject: 'Frozen',
      text: 'Frozen',
      html: '<p>Frozen</p>',
    };
    s.deliveries.startAttempt.mockResolvedValue(null as never);
    await s.service.sendBatch();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.deliveries.fail).toHaveBeenCalledWith(
      s.row,
      'provider_outcome_unresolved',
    );
  });
  it('previews every billing sample without using the email port', () => {
    const s = setup();
    for (const sample of [
      'starter',
      'basic',
      'pro',
      'business',
      'prepaid',
    ] as const)
      expect(
        s.service.preview(
          {
            translations: [
              { locale: 'en', subject: 'Launch', body: '{planLine}' },
            ],
          },
          'en',
          sample,
        ),
      ).toHaveProperty('html');
    expect(s.send).not.toHaveBeenCalled();
  });
});
