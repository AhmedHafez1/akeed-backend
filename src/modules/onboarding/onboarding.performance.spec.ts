import { Logger } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { seededTemplateRegistry } from '../../shared/messaging/testing/seeded-template-registry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('onboarding state latency', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts independent reads together and preserves viewer permissions and response fields', async () => {
    const gate = deferred<void>();
    const read = <T>(value: T) =>
      jest.fn(async () => {
        await gate.promise;
        return value;
      });
    const integration = {
      id: 'integration-a',
      orgId: 'org-a',
      platformType: 'shopify',
      onboardingStatus: 'completed',
      billingPlanId: 'basic',
      billingStatus: 'active',
      isActive: true,
      isAutoVerifyEnabled: true,
    };
    const readiness = { ready: true, variants: [] };
    const availability = { available: false, reason: 'periodic_limit_reached' };
    const onboarding = {
      resolveCurrentIntegration: jest.fn().mockResolvedValue(integration),
      prefillStoreNameIfMissing: jest.fn().mockResolvedValue(integration),
      toState: jest.fn().mockReturnValue({
        isOnboardingComplete: true,
        shippingCurrency: 'USD',
      }),
      changeRequestReadiness: read(readiness),
    };
    const lifecycle = {
      findCurrent: read({ setupCompletedAt: null, firstRealConfirmedAt: null }),
    };
    const orders = {
      hasRealOrders: read(true),
      findLatestOrderCurrency: read('EGP'),
    };
    const entitlement = {
      beginReads: jest.fn(),
      readEntitlement: read({
        includedLimit: 100,
        consumedCount: 25,
        periodStart: '2026-11-01',
        periodEnd: null,
        pools: null,
      }),
      evaluateAccess: jest.fn().mockReturnValue({ allowed: true }),
    };
    const source = { describe: read(null) };
    const sending = { read: read(availability) };
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const service = new OnboardingService(
      onboarding as never,
      {} as never,
      entitlement as never,
      {
        readStatus: jest.fn().mockResolvedValue(null),
        messagePrices: () => ({
          akeedMessagePriceMinor: 100,
          ownNumberMessagePriceMinor: 50,
        }),
      } as never,
      seededTemplateRegistry(),
      lifecycle as never,
      undefined,
      orders as never,
      source as never,
      undefined,
      undefined,
      undefined,
      sending as never,
    );
    const pending = service.getState({
      userId: 'user-a',
      orgId: 'org-a',
      source: 'shopify',
      shop: 'synthetic.myshopify.com',
      role: 'viewer',
    });
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(lifecycle.findCurrent).toHaveBeenCalledTimes(1);
    expect(entitlement.readEntitlement).toHaveBeenCalledTimes(1);
    expect(source.describe).toHaveBeenCalledTimes(1);
    expect(orders.findLatestOrderCurrency).toHaveBeenCalledWith(
      'org-a',
      'integration-a',
    );
    expect(sending.read).toHaveBeenCalledTimes(1);
    expect(onboarding.changeRequestReadiness).toHaveBeenCalledTimes(1);
    gate.resolve();
    const result = await pending;
    expect(result).toMatchObject({
      messageCurrency: 'EGP',
      sendingAvailability: availability,
      changeRequestReadiness: readiness,
      permissions: {
        canUpdateConfiguration: false,
        canCompleteOnboarding: false,
      },
      standaloneSetup: null,
    });
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).toContain('onboarding-state-read');
    expect(logs).toContain('changeRequestReadinessMs');
    expect(logs).not.toMatch(/org-a|user-a|synthetic.myshopify.com/);
  });

  it('shares one entitlement read set between the usage card and sending availability', async () => {
    const integration = {
      id: 'integration-a',
      orgId: 'org-a',
      platformType: 'shopify',
      onboardingStatus: 'completed',
      billingPlanId: 'basic',
      billingStatus: 'active',
      isActive: true,
      isAutoVerifyEnabled: true,
    };
    const reads = { source: jest.fn(), usage: jest.fn(), sender: jest.fn() };
    const entitlement = {
      beginReads: jest.fn().mockReturnValue(reads),
      readEntitlement: jest.fn().mockResolvedValue({
        includedLimit: 100,
        consumedCount: 25,
        periodStart: '2026-11-01',
        periodEnd: null,
        pools: null,
      }),
      evaluateAccess: jest.fn().mockReturnValue({ allowed: true }),
    };
    const sending = {
      read: jest.fn().mockResolvedValue({ available: true, reason: null }),
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new OnboardingService(
      {
        resolveCurrentIntegration: jest.fn().mockResolvedValue(integration),
        prefillStoreNameIfMissing: jest.fn().mockResolvedValue(integration),
        toState: jest.fn().mockReturnValue({
          isOnboardingComplete: true,
          shippingCurrency: 'USD',
        }),
      } as never,
      {} as never,
      entitlement as never,
      {
        readStatus: jest.fn().mockResolvedValue(null),
        messagePrices: () => ({
          akeedMessagePriceMinor: 100,
          ownNumberMessagePriceMinor: 50,
        }),
      } as never,
      seededTemplateRegistry(),
      {
        findCurrent: jest.fn().mockResolvedValue({
          setupCompletedAt: null,
          firstRealConfirmedAt: null,
        }),
      } as never,
      undefined,
      {
        hasRealOrders: jest.fn().mockResolvedValue(true),
        findLatestOrderCurrency: jest.fn().mockResolvedValue('EGP'),
      } as never,
      { describe: jest.fn().mockResolvedValue(null) } as never,
      undefined,
      undefined,
      undefined,
      sending as never,
    );
    await service.getState({
      userId: 'user-a',
      orgId: 'org-a',
      source: 'shopify',
      shop: 'synthetic.myshopify.com',
      role: 'owner',
    });
    expect(entitlement.beginReads).toHaveBeenCalledTimes(1);
    expect(entitlement.beginReads).toHaveBeenCalledWith(
      integration,
      integration,
    );
    expect(entitlement.readEntitlement).toHaveBeenCalledWith(
      integration,
      reads,
    );
    expect(sending.read).toHaveBeenCalledWith(integration, reads);
  });

  it('logs failure timing without hiding dependency errors or their status', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const error = new Error('synthetic dependency failure');
    const service = new OnboardingService(
      {
        resolveCurrentIntegration: jest.fn().mockRejectedValue(error),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      seededTemplateRegistry(),
    );
    await expect(
      service.getState({
        userId: 'user-a',
        orgId: 'org-a',
        source: 'shopify',
        role: 'owner',
      }),
    ).rejects.toBe(error);
    expect(JSON.stringify(log.mock.calls)).toContain('failure');
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
  });
});
