import { HttpException } from '@nestjs/common';
import { OnboardingTestService } from './onboarding-test.service';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const owner: AuthenticatedUser = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
};

function buildSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'shopify',
    platformStoreUrl: 'merchant.myshopify.com',
    isActive: true,
    onboardingStatus: 'pending',
    shippingCurrency: 'egp',
    defaultLanguage: 'auto',
    storeName: 'AAHI',
    merchantWhatsappPhone: '+201148675077',
    codTemplateArVariant: 'standard',
    codTemplateEnVariant: 'friendly',
    ...overrides,
  };
}

function setup(
  options: {
    source?: Record<string, unknown>;
    latestSentAt?: string;
    sentToday?: number;
    installedAt?: string;
  } = {},
) {
  const integrations = {
    findActiveByOrg: jest.fn().mockResolvedValue([buildSource(options.source)]),
  };
  const verifications = {
    findByIdForOrg: jest.fn().mockResolvedValue({
      id: 'verification-1',
      status: 'delivered',
      lastSentAt: '2026-09-23T08:02:00.000Z',
      deliveredAt: '2026-09-23T08:02:05.000Z',
      readAt: null,
      confirmedAt: null,
      canceledAt: null,
    }),
  };
  const hub = {
    handleSyntheticTestOrder: jest.fn().mockResolvedValue({
      orderId: 'order-1',
      verificationId: 'verification-1',
      deliveryStatus: 'sent',
    }),
  };
  const productEvents = {
    findLatest: jest.fn(({ since }: { since?: string }) =>
      Promise.resolve(
        options.latestSentAt && (!since || since <= options.latestSentAt)
          ? {
              name: 'test_sent',
              createdAt: options.latestSentAt,
              props: { verificationId: 'verification-1' },
            }
          : undefined,
      ),
    ),
    countSince: jest.fn().mockResolvedValue(options.sentToday ?? 0),
  };
  const lifecycles = {
    markMilestone: jest.fn(),
    recordEvent: jest.fn(),
    reachMilestone: jest.fn().mockResolvedValue(true),
    findCurrent: jest.fn().mockResolvedValue({
      installedAt: options.installedAt ?? '2020-01-01T00:00:00.000Z',
      testConfirmedAt: null,
      testSkippedAt: null,
    }),
  };
  const service = new OnboardingTestService(
    integrations as never,
    verifications as never,
    hub as never,
    productEvents as never,
    lifecycles as never,
  );
  return { service, hub, productEvents, lifecycles, verifications };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getResponse()).toMatchObject({ code });
}

describe('OnboardingTestService', () => {
  it('sends a free TEST-1 order in onboarding mode to the merchant number', async () => {
    const { service, hub, lifecycles } = setup();

    const status = await service.send(owner);

    expect(hub.handleSyntheticTestOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderNumber: 'TEST-1',
        totalPrice: '250.00',
        currency: 'EGP',
        customerPhone: '+201148675077',
        customerName: 'أحمد',
        rawPayload: expect.objectContaining({ source: 'onboarding_test' }),
      }),
      expect.objectContaining({ id: 'int-1' }),
      'onboarding',
    );
    expect(lifecycles.recordEvent).toHaveBeenCalledWith(
      'int-1',
      'test_sent',
      expect.objectContaining({ verificationId: 'verification-1' }),
    );
    expect(status.language).toBe('ar');
    expect(status.sample).toMatchObject({
      orderNumber: 'TEST-1',
      storeName: 'AAHI',
    });
  });

  it('records a resend separately so the funnel can count retries', async () => {
    const { service, lifecycles } = setup();

    await service.send(owner, { resend: true });

    expect(lifecycles.recordEvent).toHaveBeenCalledWith(
      'int-1',
      'test_resend',
      expect.anything(),
    );
  });

  it('uses the English sample for a non-Arabic number on auto language', async () => {
    const { service, hub } = setup({
      source: { merchantWhatsappPhone: '+14155550123' },
    });

    await service.send(owner);

    expect(hub.handleSyntheticTestOrder).toHaveBeenCalledWith(
      expect.objectContaining({ customerName: 'Ahmed' }),
      expect.anything(),
      'onboarding',
    );
  });

  it('refuses a send inside the resend cooldown with the seconds left', async () => {
    const { service, hub } = setup({
      latestSentAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const error = await service.send(owner).catch((caught: unknown) => caught);

    expectCode(error, 'ONBOARDING_TEST_COOLDOWN');
    expect((error as HttpException).getStatus()).toBe(429);
    expect(
      ((error as HttpException).getResponse() as { retryAfterSeconds: number })
        .retryAfterSeconds,
    ).toBeGreaterThan(0);
    expect(hub.handleSyntheticTestOrder).not.toHaveBeenCalled();
  });

  it('refuses a send after the daily cap', async () => {
    const { service, hub } = setup({ sentToday: 5 });

    const error = await service.send(owner).catch((caught: unknown) => caught);

    expectCode(error, 'ONBOARDING_TEST_DAILY_LIMIT');
    expect(hub.handleSyntheticTestOrder).not.toHaveBeenCalled();
  });

  it('asks for a number before sending when none is saved', async () => {
    const { service } = setup({ source: { merchantWhatsappPhone: null } });

    const error = await service.send(owner).catch((caught: unknown) => caught);

    expectCode(error, 'ONBOARDING_TEST_PHONE_MISSING');
  });

  it('reports a provider rejection without recording a sent event', async () => {
    const { service, hub, lifecycles } = setup();
    hub.handleSyntheticTestOrder.mockResolvedValueOnce({
      orderId: 'order-1',
      verificationId: 'verification-1',
      deliveryStatus: 'failed',
      reason: 'provider_rejected',
    });

    const error = await service.send(owner).catch((caught: unknown) => caught);

    expectCode(error, 'TEST_VERIFICATION_PROVIDER_FAILED');
    expect(lifecycles.recordEvent).not.toHaveBeenCalled();
  });

  it('reports the latest attempt with its delivery timeline', async () => {
    const sentAt = new Date(Date.now() - 5_000).toISOString();
    const { service, verifications } = setup({ latestSentAt: sentAt });

    const status = await service.getStatus(owner);

    expect(verifications.findByIdForOrg).toHaveBeenCalledWith(
      'verification-1',
      'org-1',
    );
    expect(status.test).toMatchObject({
      verificationId: 'verification-1',
      status: 'delivered',
    });
    expect(status.resendAvailableAt).toBe(
      new Date(new Date(sentAt).getTime() + 30_000).toISOString(),
    );
    expect(status.sendsRemainingToday).toBe(5);
  });

  it('ignores a test sent by a previous install of the same store', async () => {
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const { service, productEvents, verifications } = setup({
      latestSentAt: sentAt,
      installedAt: new Date(Date.now() - 5_000).toISOString(),
    });

    const status = await service.getStatus(owner);

    expect(productEvents.findLatest).toHaveBeenCalledWith(
      expect.objectContaining({ since: expect.any(String) }),
    );
    expect(verifications.findByIdForOrg).not.toHaveBeenCalled();
    expect(status.test).toBeNull();
    expect(status.resendAvailableAt).toBe(
      new Date(new Date(sentAt).getTime() + 30_000).toISOString(),
    );
  });

  it('records a skip as a first-hit milestone', async () => {
    const { service, lifecycles } = setup();

    await service.skip(owner);

    expect(lifecycles.reachMilestone).toHaveBeenCalledWith(
      'int-1',
      'testSkippedAt',
      'test_skipped',
      expect.anything(),
    );
  });

  it('keeps viewers from sending tests', async () => {
    const { service } = setup();

    const error = await service
      .send({ ...owner, role: 'viewer' })
      .catch((caught: unknown) => caught);

    expectCode(error, 'TEST_VERIFICATION_ROLE_REQUIRED');
  });
});
