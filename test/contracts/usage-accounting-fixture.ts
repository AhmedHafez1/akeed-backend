import type { UsageAccountingRouter } from '../../src/infrastructure/database/repositories/usage-accounting.router';

export function usageAccountingFixture(
  options: { enabled?: boolean } = {},
): UsageAccountingRouter {
  const enabled = options.enabled ?? false;
  return {
    isEnabled: () => enabled,
    // Mirrors the real router: with credit billing off a Standalone source
    // stays on the periodic plan it shipped with, so this fixture reproduces a
    // dark deploy rather than denying every Standalone action.
    mode: (platform: string) =>
      platform === 'standalone' && enabled ? 'prepaid_credit' : 'periodic_plan',
    readAvailability: jest.fn().mockResolvedValue({
      available: enabled,
      reason: enabled ? null : 'PAYMENT_PENDING_RECONCILIATION',
      consumedCount: 0,
      includedLimit: 30,
      credits: {
        postedBalance: 30,
        heldCredits: 0,
        availableCredits: 30,
        debtCredits: 0,
        status: 'active',
      },
    }),
  } as unknown as UsageAccountingRouter;
}
