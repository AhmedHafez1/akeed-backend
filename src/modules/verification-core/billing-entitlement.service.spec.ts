import { BillingEntitlementService } from './billing-entitlement.service';

describe('BillingEntitlementService', () => {
  describe('getBillingPeriodStart', () => {
    let service: BillingEntitlementService;

    beforeEach(() => {
      // Instantiate with null dependencies — only testing pure method
      service = new BillingEntitlementService(null as any, null as any);
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
