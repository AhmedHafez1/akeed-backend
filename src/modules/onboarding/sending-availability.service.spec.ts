import { SendingAvailabilityService } from './sending-availability.service';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { resolveBillingPlan } from '../../shared/billing/billing-plan';
import type { integrations } from '../../infrastructure/database/schema';

function setup(overrides: Record<string, unknown> = {}, used = 0) {
  const source = {
    id: 'source-1',
    orgId: 'org-1',
    platformType: 'shopify',
    isActive: true,
    onboardingStatus: 'completed',
    isAutoVerifyEnabled: true,
    billingStatus: null,
    billingPlanId: null,
    billingActivatedAt: null,
    billingCanceledAt: null,
    paidThroughAt: null,
    ...overrides,
  } as typeof integrations.$inferSelect;
  const entitlement = new BillingEntitlementService({
    getEntitlementSource: jest.fn().mockResolvedValue(source),
    getIntegrationUsageForPeriod: jest
      .fn()
      .mockResolvedValue({ consumedCount: used }),
  } as never);
  const notices = {
    countMissedOrders: jest.fn().mockResolvedValue({
      count: 0,
      since: '2026-11-10T00:00:00Z',
      until: '2026-11-12T00:00:00Z',
    }),
  };
  const service = new SendingAvailabilityService(
    entitlement,
    notices as never,
    {
      resolvePlan: (id: 'pro') =>
        resolveBillingPlan({ planId: id, currencyCode: 'USD', testMode: true }),
    } as never,
  );
  return { source, notices, service };
}

describe('Shopify sending availability', () => {
  it.each([
    [{}, 0, 'billing_not_active', 'none', null],
    [
      {
        billingPlanId: 'pro',
        billingStatus: 'cancelled',
        billingCanceledAt: '2026-11-11T00:00:00Z',
      },
      10,
      'billing_not_active',
      'cancelled',
      null,
    ],
    [
      { billingPlanId: 'pro', billingStatus: 'active' },
      0,
      null,
      'active',
      'pro',
    ],
    [
      { billingPlanId: 'pro', billingStatus: 'active' },
      1000,
      'plan_limit_reached',
      'active',
      'pro',
    ],
    [
      { billingPlanId: 'pro', billingStatus: 'frozen' },
      0,
      'billing_not_active',
      'frozen',
      null,
    ],
    [
      { isActive: false, billingStatus: 'cancelled' },
      0,
      'integration_inactive',
      'none',
      null,
    ],
    [
      {
        billingPlanId: 'pro',
        billingStatus: 'paid_through',
        paidThroughAt: '2099-01-01T00:00:00Z',
      },
      0,
      null,
      'paid_through',
      'pro',
    ],
    [
      {
        billingPlanId: 'pro',
        billingStatus: 'paid_through',
        paidThroughAt: '2020-01-01T00:00:00Z',
      },
      0,
      'billing_not_active',
      'cancelled',
      null,
    ],
    [
      {
        billingPlanId: 'pro',
        billingStatus: 'active',
        isAutoVerifyEnabled: false,
      },
      0,
      'auto_verify_disabled',
      'active',
      'pro',
    ],
  ])(
    'reports %j with usage %s',
    async (overrides, used, reason, planState, currentPlanId) => {
      const { service, source } = setup(overrides, used);
      expect(await service.read(source)).toMatchObject({
        available: reason === null,
        reason,
        planState,
        currentPlanId,
      });
    },
  );
  it('retains the previous plan and cancellation date, without treating it as current', async () => {
    const { source, service, notices } = setup({
      billingPlanId: 'pro',
      billingStatus: 'cancelled',
      billingCanceledAt: '2026-11-11T00:00:00Z',
    });
    expect(await service.read(source)).toMatchObject({
      lastPlanId: 'pro',
      lastPlanName: 'Akeed Pro',
      cancelledAt: '2026-11-11T00:00:00Z',
      currentPlanId: null,
      missedOrders: { count: 0 },
    });
    expect(notices.countMissedOrders).toHaveBeenCalledWith(
      source,
      expect.any(Date),
    );
  });
});
