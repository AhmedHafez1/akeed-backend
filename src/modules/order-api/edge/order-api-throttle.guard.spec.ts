import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import {
  ORDER_API_CONFIG,
  type OrderApiConfig,
} from '../../../shared/config/order-api.config';
import type { IntegrationApiKeyPrincipal } from '../../integration-keys/integration-api-key.principal';
import {
  OrderApiIngressThrottleGuard,
  OrderApiThrottleGuard,
} from './order-api-throttle.guard';

const LIMITS: OrderApiConfig = {
  perIntegrationPerMinute: 3,
  globalPerMinute: 5,
  preAuthPerIpPerMinute: 4,
  maxBodyBytes: 32 * 1024,
};

const config = {
  get: (key: string) => (key === ORDER_API_CONFIG ? LIMITS : undefined),
} as unknown as ConfigService;

function principalOf(
  integrationId: string,
  keyId = `key-of-${integrationId}`,
): IntegrationApiKeyPrincipal {
  return {
    orgId: `org-of-${integrationId}`,
    integrationId,
    keyId,
    prefix: `ak_live_${keyId}`,
  };
}

/** One request through a guard: allowed, or the 429 it was refused with. */
async function attempt(
  guard: OrderApiThrottleGuard | OrderApiIngressThrottleGuard,
  request: { integrationApiKey?: IntegrationApiKeyPrincipal; ip?: string },
) {
  const header = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header }),
    }),
  } as unknown as ExecutionContext;
  try {
    await guard.canActivate(context);
    return { allowed: true as const };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const retryAfter = header.mock.calls.find(
      ([name]) => name === 'Retry-After',
    ) as [string, string] | undefined;
    return {
      allowed: false as const,
      status: error.getStatus(),
      code: (error.getResponse() as { code: string }).code,
      retryAfter: retryAfter ? Number(retryAfter[1]) : undefined,
    };
  }
}

describe('order API throttling', () => {
  let storage: ThrottlerStorageService;
  let guard: OrderApiThrottleGuard;
  let ingress: OrderApiIngressThrottleGuard;

  const call = (integrationId: string, keyId?: string) =>
    attempt(guard, { integrationApiKey: principalOf(integrationId, keyId) });

  beforeEach(() => {
    jest.useFakeTimers();
    storage = new ThrottlerStorageService();
    guard = new OrderApiThrottleGuard(storage, config);
    ingress = new OrderApiIngressThrottleGuard(storage, config);
  });

  afterEach(() => {
    storage.onApplicationShutdown();
    jest.useRealTimers();
  });

  it('lets an integration through up to its limit, then answers 429 API_RATE_LIMITED with Retry-After', async () => {
    for (let index = 0; index < LIMITS.perIntegrationPerMinute; index++)
      expect(await call('integration-a')).toEqual({ allowed: true });

    const refused = await call('integration-a');
    expect(refused).toMatchObject({
      allowed: false,
      status: 429,
      code: 'API_RATE_LIMITED',
    });
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfter).toBeLessThanOrEqual(60);
  });

  it('counts concurrent requests one by one', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('integration-a')),
    );
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(
      LIMITS.perIntegrationPerMinute,
    );
  });

  it('counts by integration, so a rotated or second key does not bypass the limit', async () => {
    for (let index = 0; index < LIMITS.perIntegrationPerMinute; index++)
      await call('integration-a', 'old-key');

    expect(await call('integration-a', 'old-key')).toMatchObject({
      allowed: false,
    });
    expect(await call('integration-a', 'rotated-key')).toMatchObject({
      allowed: false,
      code: 'API_RATE_LIMITED',
    });
  });

  it('does not let one integration throttle another', async () => {
    for (let index = 0; index < LIMITS.perIntegrationPerMinute + 1; index++)
      await call('integration-a');

    expect(await call('integration-b')).toEqual({ allowed: true });
  });

  it('applies the global limit across integrations', async () => {
    // 3 + 2 requests use up the global budget of 5 without any integration
    // reaching its own limit of 3 for the second one.
    for (let index = 0; index < 3; index++) await call('integration-a');
    for (let index = 0; index < 2; index++) await call('integration-b');

    expect(await call('integration-c')).toMatchObject({
      allowed: false,
      status: 429,
      code: 'API_RATE_LIMITED',
    });
  });

  it('does not spend the global budget on requests the integration limit refused', async () => {
    for (let index = 0; index < 20; index++) await call('integration-a');

    // Only integration-a's 3 allowed requests counted globally: 2 remain.
    expect(await call('integration-b')).toEqual({ allowed: true });
    expect(await call('integration-b')).toEqual({ allowed: true });
    expect(await call('integration-c')).toMatchObject({ allowed: false });
  });

  it('lets a retry through once the Retry-After period has passed', async () => {
    for (let index = 0; index < LIMITS.perIntegrationPerMinute; index++)
      await call('integration-a');
    const refused = await call('integration-a');
    expect(refused.allowed).toBe(false);

    jest.advanceTimersByTime(refused.retryAfter! * 1000 - 1000);
    expect(await call('integration-a')).toMatchObject({ allowed: false });

    jest.advanceTimersByTime(1001);
    expect(await call('integration-a')).toEqual({ allowed: true });
  });

  it('keeps counting each bucket on its own clock when another bucket leaves its block', async () => {
    // integration-a is blocked for a minute.
    for (let index = 0; index < LIMITS.perIntegrationPerMinute + 1; index++)
      await call('integration-a');
    // Half a minute later integration-b uses two of its three requests.
    jest.advanceTimersByTime(30_000);
    await call('integration-b');
    await call('integration-b');
    // integration-a's block ends and it calls again.
    jest.advanceTimersByTime(31_000);
    expect(await call('integration-a')).toEqual({ allowed: true });

    // Over a minute later every earlier request has aged out, so
    // integration-b has its whole budget again.
    jest.advanceTimersByTime(61_000);
    for (let index = 0; index < LIMITS.perIntegrationPerMinute; index++)
      expect(await call('integration-b')).toEqual({ allowed: true });
  });

  it('refuses to run without the principal of the key guard', async () => {
    await expect(attempt(guard, {})).rejects.toThrow(
      'OrderApiThrottleGuard used before IntegrationApiKeyGuard',
    );
  });

  describe('before authentication', () => {
    it('bounds requests from one address and leaves other addresses alone', async () => {
      for (let index = 0; index < LIMITS.preAuthPerIpPerMinute; index++)
        expect(await attempt(ingress, { ip: '203.0.113.7' })).toEqual({
          allowed: true,
        });

      const refused = await attempt(ingress, { ip: '203.0.113.7' });
      expect(refused).toMatchObject({
        allowed: false,
        status: 429,
        code: 'API_RATE_LIMITED',
      });
      expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
      expect(await attempt(ingress, { ip: '203.0.113.8' })).toEqual({
        allowed: true,
      });
    });

    it('keeps its own count, apart from the integration and global buckets', async () => {
      for (let index = 0; index < LIMITS.preAuthPerIpPerMinute + 1; index++)
        await attempt(ingress, { ip: '203.0.113.7' });

      expect(await call('integration-a')).toEqual({ allowed: true });
    });

    it('still bounds a request whose address is unknown', async () => {
      for (let index = 0; index < LIMITS.preAuthPerIpPerMinute; index++)
        await attempt(ingress, {});

      expect(await attempt(ingress, {})).toMatchObject({ allowed: false });
    });
  });
});
