import { BillingEntitlementService } from './billing-entitlement.service';
import type { integrations } from '../../infrastructure/database/schema';

describe('BillingEntitlementService repository delegation', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  function setup(billingPlanId: string | null) {
    const repository = {
      reserveMonthlyVerificationSlot: jest.fn().mockResolvedValue({
        allowed: true,
        consumedCount: 1,
        isOverage: false,
      }),
      getIntegrationUsageForPeriod: jest
        .fn()
        .mockResolvedValue({ consumedCount: 1 }),
      releaseMonthlyVerificationSlot: jest.fn().mockResolvedValue(undefined),
    };
    const integration = {
      id: 'int-1',
      orgId: 'org-1',
      billingPlanId,
      billingActivatedAt: '2026-05-01T00:00:00.000Z',
    } as typeof integrations.$inferSelect;
    return {
      repository,
      integration,
      service: new BillingEntitlementService(repository as never),
    };
  }

  it.each([
    ['starter', 'starter', 30],
    ['basic', 'basic', 300],
    ['pro', 'pro', 1000],
    ['business', 'business', 2500],
    [null, 'starter', 30],
    ['unknown', 'starter', 30],
  ])(
    'reserves and checks availability for plan %p',
    async (rawPlan, planId, includedLimit) => {
      const { service, repository, integration } = setup(rawPlan);
      await expect(
        service.reserveVerificationSlot(integration),
      ).resolves.toMatchObject({
        allowed: true,
        periodStart: '2026-05-01',
        planId,
      });
      expect(repository.reserveMonthlyVerificationSlot).toHaveBeenCalledWith({
        orgId: 'org-1',
        integrationId: 'int-1',
        periodStart: '2026-05-01',
        includedLimit,
        overageAllowed: false,
      });
      await expect(service.hasAvailableSlot(integration)).resolves.toEqual({
        available: true,
        consumedCount: 1,
        includedLimit,
      });
      expect(repository.getIntegrationUsageForPeriod).toHaveBeenCalledWith({
        integrationId: 'int-1',
        periodStart: '2026-05-01',
      });
      repository.getIntegrationUsageForPeriod.mockResolvedValue({
        consumedCount: includedLimit,
      });
      await expect(service.hasAvailableSlot(integration)).resolves.toEqual({
        available: false,
        consumedCount: includedLimit,
        includedLimit,
      });
    },
  );

  it('returns denied reservation and propagates release arguments/errors', async () => {
    const { service, repository, integration } = setup('basic');
    repository.reserveMonthlyVerificationSlot.mockResolvedValue({
      allowed: false,
      consumedCount: 300,
      isOverage: false,
    });
    await expect(
      service.reserveVerificationSlot(integration),
    ).resolves.toMatchObject({
      allowed: false,
      planId: 'basic',
      periodStart: '2026-05-01',
    });
    const release = { integrationId: 'int-1', periodStart: '2026-04-01' };
    await service.releaseVerificationSlot(release);
    expect(repository.releaseMonthlyVerificationSlot).toHaveBeenCalledWith(
      release,
    );
    repository.releaseMonthlyVerificationSlot.mockRejectedValue(
      new Error('release failed'),
    );
    await expect(service.releaseVerificationSlot(release)).rejects.toThrow(
      'release failed',
    );
  });
});

describe('BillingEntitlementService', () => {
  describe('getBillingPeriodStart', () => {
    let service: BillingEntitlementService;

    beforeEach(() => {
      // Instantiate with null dependencies — only testing pure method
      service = new BillingEntitlementService(null as any);
    });

    it('returns 1st of current month when no activation date', () => {
      const now = new Date('2026-03-15T12:00:00Z');
      const result = service.getBillingPeriodStart(null, now);
      expect(result).toBe('2026-03-01');
    });

    it('returns 1st of current month for undefined activation', () => {
      const now = new Date('2026-06-20T00:00:00Z');
      const result = service.getBillingPeriodStart(undefined, now);
      expect(result).toBe('2026-06-01');
    });

    it('returns 1st of current month for invalid activation date', () => {
      const now = new Date('2026-01-10T00:00:00Z');
      const result = service.getBillingPeriodStart('invalid-date', now);
      expect(result).toBe('2026-01-01');
    });

    it('returns activation date when within first 30-day cycle', () => {
      const activation = new Date('2026-03-01T00:00:00Z');
      const now = new Date('2026-03-15T00:00:00Z');
      const result = service.getBillingPeriodStart(activation, now);
      expect(result).toBe('2026-03-01');
    });

    it('returns second cycle start after 30 days', () => {
      const activation = new Date('2026-01-01T00:00:00Z');
      const now = new Date('2026-01-31T12:00:00Z'); // 30 days after activation
      const result = service.getBillingPeriodStart(activation, now);
      expect(result).toBe('2026-01-31');
    });

    it('returns third cycle start after 60 days', () => {
      const activation = new Date('2026-01-01T00:00:00Z');
      const now = new Date('2026-03-02T12:00:00Z'); // 60 days after activation
      const result = service.getBillingPeriodStart(activation, now);
      expect(result).toBe('2026-03-02');
    });

    it('returns activation date when activation is in the future', () => {
      const activation = new Date('2026-06-01T00:00:00Z');
      const now = new Date('2026-05-15T00:00:00Z');
      const result = service.getBillingPeriodStart(activation, now);
      expect(result).toBe('2026-06-01');
    });

    it('accepts string activation date', () => {
      const now = new Date('2026-02-15T00:00:00Z');
      const result = service.getBillingPeriodStart('2026-02-01T00:00:00Z', now);
      expect(result).toBe('2026-02-01');
    });

    it('handles exact 30-day boundary', () => {
      const activation = new Date('2026-01-01T00:00:00Z');
      const now = new Date('2026-01-31T00:00:00Z'); // exactly 30 days
      const result = service.getBillingPeriodStart(activation, now);
      expect(result).toBe('2026-01-31');
    });

    it('handles day 29 (still in first cycle)', () => {
      const activation = new Date('2026-01-01T00:00:00Z');
      const now = new Date('2026-01-30T23:59:59Z'); // 29 full days
      const result = service.getBillingPeriodStart(activation, now);
      expect(result).toBe('2026-01-01');
    });
  });
});
