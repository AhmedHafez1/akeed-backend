import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { PaymentCallbackRateLimitGuard } from './payment-callback-rate-limit.guard';

function contextFor(ip: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip, socket: {} }) }),
  } as unknown as ExecutionContext;
}

function drain(
  guard: PaymentCallbackRateLimitGuard,
  ip: string,
  count: number,
) {
  for (let index = 0; index < count; index += 1)
    guard.canActivate(contextFor(ip));
}

describe('PaymentCallbackRateLimitGuard', () => {
  afterEach(() => jest.useRealTimers());

  it('lets a provider retry burst through', () => {
    // Sized above a plausible settlement or redelivery wave: refusing a
    // legitimate retry is worse than the load it represents.
    const guard = new PaymentCallbackRateLimitGuard();
    expect(() => drain(guard, '203.0.113.1', 120)).not.toThrow();
  });

  it('refuses past the ceiling with a Retry-After the caller can honour', () => {
    const guard = new PaymentCallbackRateLimitGuard();
    drain(guard, '203.0.113.2', 120);
    try {
      guard.canActivate(contextFor('203.0.113.2'));
      throw new Error('expected a rate-limit rejection');
    } catch (error) {
      const response = (
        error as { getResponse: () => { retryAfter: number } }
      ).getResponse();
      expect((error as { getStatus: () => number }).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(response.retryAfter).toBeGreaterThan(0);
    }
  });

  it('counts each caller separately', () => {
    const guard = new PaymentCallbackRateLimitGuard();
    drain(guard, '203.0.113.3', 120);
    expect(guard.canActivate(contextFor('203.0.113.4'))).toBe(true);
  });

  it('reopens the window once it has passed', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T10:00:00Z'));
    const guard = new PaymentCallbackRateLimitGuard();
    drain(guard, '203.0.113.5', 120);
    expect(() => guard.canActivate(contextFor('203.0.113.5'))).toThrow();
    jest.setSystemTime(new Date('2026-09-09T10:01:01Z'));
    expect(guard.canActivate(contextFor('203.0.113.5'))).toBe(true);
  });

  it('treats a caller with no address as one bucket rather than crashing', () => {
    const guard = new PaymentCallbackRateLimitGuard();
    const context = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(context)).toBe(true);
  });
});
