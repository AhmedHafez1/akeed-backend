import { HttpException } from '@nestjs/common';
import { PhoneService } from '../../shared/services/phone.service';
import { TestVerificationService } from './test-verification.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const standaloneUser: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  source: 'supabase',
};

function buildSource(platformType = 'standalone') {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType,
    platformStoreUrl:
      platformType === 'standalone'
        ? 'standalone:org-1'
        : 'merchant.example.test',
    isActive: true,
    onboardingStatus: 'completed',
    shippingCurrency: 'egp',
  };
}

function setup() {
  const integrations = {
    findByOrgAndPlatformDomain: jest.fn(),
    findActiveByOrg: jest.fn().mockResolvedValue([buildSource()]),
    findByOrg: jest.fn(),
  };
  const hub = {
    handleSyntheticTestOrder: jest.fn().mockResolvedValue({
      orderId: 'order-1',
      verificationId: 'verification-1',
      deliveryStatus: 'sent',
    }),
  };
  const memberships = {
    findByOrgAndUser: jest.fn().mockResolvedValue({ role: 'owner' }),
  };
  const lifecycle = { markMilestone: jest.fn() };
  const service = new TestVerificationService(
    integrations as never,
    hub as never,
    new PhoneService(),
    memberships as never,
    lifecycle as never,
  );
  return { service, integrations, hub, memberships, lifecycle };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getResponse()).toMatchObject({ code });
}

describe('TestVerificationService', () => {
  it('sends an immediate synthetic test through the shared source-neutral hub', async () => {
    const { service, integrations, hub, lifecycle } = setup();

    await expect(
      service.sendTestVerification(standaloneUser, '+201001234567'),
    ).resolves.toEqual({
      orderId: 'order-1',
      verificationId: 'verification-1',
    });

    expect(integrations.findByOrgAndPlatformDomain).not.toHaveBeenCalled();
    expect(hub.handleSyntheticTestOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        integrationId: 'int-1',
        externalOrderId: expect.stringMatching(/^akeed-test-[0-9a-f-]+$/),
        orderNumber: expect.stringMatching(/^AKEED-TEST-/),
        customerPhone: '+201001234567',
        customerName: 'Akeed Test Recipient',
        currency: 'EGP',
        rawPayload: expect.objectContaining({
          synthetic: true,
          externalCommerceActionAllowed: false,
        }),
      }),
      expect.objectContaining({ id: 'int-1' }),
    );
    expect(lifecycle.markMilestone).toHaveBeenCalledWith(
      'int-1',
      'testRequestedAt',
      undefined,
      { test_requested: 'captured_exact' },
    );
  });

  it('uses the same immediate test command for Shopify and future sources', async () => {
    const { service, integrations, hub } = setup();
    const shopify = buildSource('shopify');
    integrations.findByOrgAndPlatformDomain.mockResolvedValue(shopify);

    await service.sendTestVerification(
      {
        userId: 'shopify-owner',
        orgId: 'org-1',
        source: 'shopify',
        shop: 'merchant.example.test',
      },
      '+201001234567',
    );

    integrations.findActiveByOrg.mockResolvedValue([buildSource('easyorders')]);
    await service.sendTestVerification(standaloneUser, '+201001234567');

    expect(hub.handleSyntheticTestOrder).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      shopify,
    );
    expect(hub.handleSyntheticTestOrder).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ platformType: 'easyorders' }),
    );
  });

  it('rejects a viewer before resolving or sending from a source', async () => {
    const { service, integrations, hub, memberships } = setup();
    memberships.findByOrgAndUser.mockResolvedValue({ role: 'viewer' });

    await service
      .sendTestVerification(standaloneUser, '+201001234567')
      .then(() => fail('Expected viewer access to be rejected'))
      .catch((error: unknown) =>
        expectCode(error, 'TEST_VERIFICATION_ROLE_REQUIRED'),
      );
    expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
    expect(hub.handleSyntheticTestOrder).not.toHaveBeenCalled();
  });

  it('returns an actionable invalid-phone error before source lookup', async () => {
    const { service, integrations, hub } = setup();

    await service
      .sendTestVerification(standaloneUser, '123')
      .then(() => fail('Expected invalid phone to be rejected'))
      .catch((error: unknown) =>
        expectCode(error, 'TEST_VERIFICATION_INVALID_PHONE'),
      );
    expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
    expect(hub.handleSyntheticTestOrder).not.toHaveBeenCalled();
  });

  it('returns actionable source and entitlement errors without a Shopify lookup', async () => {
    const { service, integrations, hub } = setup();
    integrations.findActiveByOrg.mockResolvedValue([]);
    integrations.findByOrg.mockResolvedValue([]);

    await service
      .sendTestVerification(standaloneUser, '+201001234567')
      .then(() => fail('Expected missing source to be rejected'))
      .catch((error: unknown) =>
        expectCode(error, 'TEST_VERIFICATION_SOURCE_UNAVAILABLE'),
      );

    integrations.findActiveByOrg.mockResolvedValue([buildSource()]);
    hub.handleSyntheticTestOrder.mockResolvedValue({
      skipped: true,
      reason: 'billing_not_active',
    });
    await service
      .sendTestVerification(standaloneUser, '+201001234567')
      .then(() => fail('Expected missing entitlement to be rejected'))
      .catch((error: unknown) =>
        expectCode(error, 'TEST_VERIFICATION_ENTITLEMENT_REQUIRED'),
      );

    expect(integrations.findByOrgAndPlatformDomain).not.toHaveBeenCalled();
  });

  it('reports provider failure instead of claiming the test was sent', async () => {
    const { service, hub } = setup();
    hub.handleSyntheticTestOrder.mockResolvedValue({
      orderId: 'order-1',
      verificationId: 'verification-1',
      deliveryStatus: 'failed',
      reason: 'send_error',
    });

    await service
      .sendTestVerification(standaloneUser, '+201001234567')
      .then(() => fail('Expected provider failure to be rejected'))
      .catch((error: unknown) =>
        expectCode(error, 'TEST_VERIFICATION_PROVIDER_FAILED'),
      );
  });

  it('preserves the shared quota result', async () => {
    const { service, hub } = setup();
    hub.handleSyntheticTestOrder.mockResolvedValue({
      skipped: true,
      reason: 'plan_limit_reached',
    });

    await expect(
      service.sendTestVerification(standaloneUser, '+201001234567'),
    ).resolves.toEqual({ skipped: true, reason: 'plan_limit_reached' });
  });
});
