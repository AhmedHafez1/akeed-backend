import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import { BillingEntitlementService } from './billing-entitlement.service';

describe('BillingEntitlementService', () => {
  describe('getBillingPeriodStart', () => {
    let service: BillingEntitlementService;

    beforeEach(() => {
      // Instantiate with null dependencies — only testing pure method
      service = new BillingEntitlementService(
        null as any,
        usageAccountingFixture(),
      );
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

  describe('evaluateAccess', () => {
    const frozen = {
      id: 'integration-1',
      orgId: 'org-1',
      platformType: 'standalone',
      isActive: true,
      billingStatus: 'frozen',
      billingPlanId: 'starter',
      billingActivatedAt: '2026-09-01T00:00:00Z',
    };

    it('applies the periodic plan rule to Standalone while credit billing is off', () => {
      const service = new BillingEntitlementService(
        null as never,
        usageAccountingFixture(),
      );
      expect(service.evaluateAccess(frozen)).toMatchObject({
        allowed: false,
        reason: 'billing_not_active',
      });
    });

    it('leaves Standalone eligibility to credits once credit billing is on', () => {
      const service = new BillingEntitlementService(
        null as never,
        usageAccountingFixture({ enabled: true }),
      );
      expect(service.evaluateAccess(frozen)).toMatchObject({
        allowed: true,
        reason: null,
      });
    });
  });

  describe('request-scoped reads', () => {
    const source = {
      id: 'integration-1',
      orgId: 'org-1',
      platformType: 'shopify',
      isActive: true,
      billingStatus: 'active',
      billingPlanId: 'basic',
      billingActivatedAt: '2026-11-01T00:00:00Z',
      paidThroughAt: null,
    };

    function build() {
      const repository = {
        getEntitlementSource: jest.fn().mockResolvedValue(source),
        getIntegrationUsageForPeriod: jest.fn().mockResolvedValue({
          consumedCount: 3,
          includedLimit: 30,
          ownNumberConsumed: 0,
        }),
      };
      const senders = { predict: jest.fn().mockResolvedValue('akeed_system') };
      const service = new BillingEntitlementService(
        repository as never,
        usageAccountingFixture(),
        senders as never,
      );
      return { repository, senders, service };
    }

    it('reads the source, usage and sender once across the usage card and the slot check', async () => {
      const { repository, senders, service } = build();
      const reads = service.beginReads(source);
      const entitlement = await service.readEntitlement(source, reads);
      const slot = await service.hasAvailableSlot(source, reads);
      expect(entitlement).toMatchObject({ allowed: true, consumedCount: 3 });
      expect(slot).toMatchObject({ available: true, consumedCount: 3 });
      expect(repository.getEntitlementSource).toHaveBeenCalledTimes(1);
      expect(repository.getIntegrationUsageForPeriod).toHaveBeenCalledTimes(1);
      expect(senders.predict).toHaveBeenCalledTimes(1);
    });

    it('reads fresh state on every call without a shared set', async () => {
      const { repository, service } = build();
      await service.readEntitlement(source);
      await service.hasAvailableSlot(source);
      expect(repository.getEntitlementSource).toHaveBeenCalledTimes(2);
      expect(repository.getIntegrationUsageForPeriod).toHaveBeenCalledTimes(2);
    });

    it('accepts a seed only for the same integration and organization', async () => {
      const { repository, service } = build();
      const seeded = await service.readEntitlement(
        source,
        service.beginReads(source, { ...source, billingPlanId: 'pro' }),
      );
      expect(seeded.planId).toBe('pro');
      expect(repository.getEntitlementSource).not.toHaveBeenCalled();

      await service.readEntitlement(
        source,
        service.beginReads(source, { ...source, id: 'integration-2' }),
      );
      await service.readEntitlement(
        source,
        service.beginReads(source, { ...source, orgId: 'org-2' }),
      );
      expect(repository.getEntitlementSource).toHaveBeenCalledTimes(2);
    });

    it('forgets a failed read so the next call can retry', async () => {
      const { repository, service } = build();
      repository.getEntitlementSource.mockRejectedValueOnce(
        new Error('synthetic unavailable'),
      );
      const reads = service.beginReads(source);
      await expect(reads.source()).rejects.toThrow('synthetic unavailable');
      await expect(reads.source()).resolves.toEqual(source);
      expect(repository.getEntitlementSource).toHaveBeenCalledTimes(2);
    });
  });
});
