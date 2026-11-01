import { ForbiddenException } from '@nestjs/common';
import { CreditModelNoticeService } from './credit-model-notice.service';
import { USAGE_ALERTS_CONFIG } from '../../shared/config/usage-alerts.config';

function create(enabled: boolean) {
  const notices = {
    isVisible: jest.fn().mockResolvedValue(true),
    dismiss: jest.fn().mockResolvedValue(undefined),
    claimEmailBatch: jest.fn().mockResolvedValue(['org-1']),
    markEmail: jest.fn().mockResolvedValue(undefined),
  };
  const integrations = {
    findActiveByOrg: jest.fn().mockResolvedValue([
      {
        platformType: 'woocommerce',
        storeName: 'Store',
        defaultLanguage: 'en',
        notificationEmail: null,
      },
    ]),
  };
  const alerts = {
    findOwnerEmail: jest.fn().mockResolvedValue('owner@example.test'),
  };
  const email = { send: jest.fn().mockResolvedValue({ status: 'sent' }) };
  const config = {
    get: (key: string) =>
      key === USAGE_ALERTS_CONFIG
        ? { creditModelNoticeEmailEnabled: enabled, dashboardUrl: null }
        : undefined,
  };
  const service = new CreditModelNoticeService(
    notices as never,
    integrations as never,
    alerts as never,
    config as never,
    email as never,
  );
  return { service, notices, integrations, email };
}

const owner = { orgId: 'org-1', role: 'owner' } as never;
const viewer = { orgId: 'org-1', role: 'viewer' } as never;

describe('CreditModelNoticeService', () => {
  it('reads visibility and whether this member may dismiss', async () => {
    const { service } = create(false);
    await expect(service.read(owner)).resolves.toEqual({
      visible: true,
      canDismiss: true,
    });
    await expect(service.read(viewer)).resolves.toEqual({
      visible: true,
      canDismiss: false,
    });
  });

  it('dismisses for a member who can write and refuses a viewer', async () => {
    const { service, notices } = create(false);
    await service.dismiss(owner);
    expect(notices.dismiss).toHaveBeenCalledWith('org-1');
    await expect(service.dismiss(viewer)).rejects.toThrow(ForbiddenException);
  });

  it('sends nothing and claims nothing while the switch is off', async () => {
    const { service, notices, email } = create(false);
    await expect(service.sendEmailBatch()).resolves.toBe(0);
    expect(notices.claimEmailBatch).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends once with an idempotency key and records the result', async () => {
    const { service, notices, email } = create(true);
    await expect(service.sendEmailBatch()).resolves.toBe(1);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.test',
        idempotencyKey: 'credit-model-notice-org-1',
      }),
    );
    expect(notices.markEmail).toHaveBeenCalledWith('org-1', 'sent', undefined);
  });

  it('skips an organization with no prepaid source', async () => {
    const { service, integrations, notices, email } = create(true);
    integrations.findActiveByOrg.mockResolvedValue([
      { platformType: 'shopify' },
    ]);
    await service.sendEmailBatch();
    expect(email.send).not.toHaveBeenCalled();
    expect(notices.markEmail).toHaveBeenCalledWith(
      'org-1',
      'skipped',
      'no_prepaid_source',
    );
  });

  it('records a provider exception without repeating the send', async () => {
    const { service, notices, email } = create(true);
    email.send.mockRejectedValue(new Error('down'));
    await service.sendEmailBatch();
    expect(notices.markEmail).toHaveBeenCalledWith(
      'org-1',
      'failed',
      'send_threw',
    );
  });
});
