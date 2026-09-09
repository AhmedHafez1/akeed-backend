import { usageAccountingFixture } from '../../../test/contracts/usage-accounting-fixture';
import { VerificationsService } from './verifications.service';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';

describe('integration-scoped dashboard entitlement usage', () => {
  const source = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    isActive: true,
    billingStatus: 'not_required',
    billingPlanId: 'starter',
    billingActivatedAt: '2026-05-01T00:00:00Z',
  };
  function setup(sources = [source]) {
    const verifications = {
      getFunnelCountsByOrgAndPeriod: jest.fn().mockResolvedValue({
        total: 5,
        pending: 0,
        failed: 0,
        awaitingReply: 0,
        confirmed: 3,
        canceled: 2,
        customerCanceled: 2,
        sent: 5,
        delivered: 5,
        read: 5,
        followUpsSent: 0,
      }),
    };
    const repository = {
      getEntitlementSource: jest.fn().mockResolvedValue(source),
      getIntegrationUsageForPeriod: jest
        .fn()
        .mockResolvedValue({ consumedCount: 12, includedLimit: 2500 }),
    };
    const entitlements = new BillingEntitlementService(
      repository as never,
      usageAccountingFixture(),
    );
    const service = new VerificationsService(
      verifications as never,
      entitlements,
      { findByOrg: jest.fn().mockResolvedValue(sources) } as never,
      {} as never,
      {} as never,
    );
    return { service, repository };
  }
  it('uses prepaid availability without reading the legacy monthly quota', async () => {
    const { service, repository } = setup();
    const result = await service.getStatsByOrg('org-1', {});
    expect(result.usage).toMatchObject({ used: 0, limit: 30 });
    expect(repository.getIntegrationUsageForPeriod).not.toHaveBeenCalled();
  });
  it('keeps historical funnel totals when no current source is active, without inventing a quota', async () => {
    const { service, repository } = setup([]);
    const result = await service.getStatsByOrg('org-1', {});
    expect(result.usage).toEqual({
      used: 0,
      limit: 0,
      period_start: null,
      period_end: null,
    });
    expect(result.totals).toMatchObject({ confirmed: 3, canceled: 2 });
    expect(result.source.status).toBe('not_connected');
    expect(result.automation).toMatchObject({
      is_auto_verify_enabled: false,
      follow_up_enabled: false,
    });
    expect(repository.getEntitlementSource).not.toHaveBeenCalled();
  });
  it('reports a disconnected source while retaining historical totals', async () => {
    const { service, repository } = setup([{ ...source, isActive: false }]);
    const result = await service.getStatsByOrg('org-1', {});
    expect(result.source).toEqual({
      status: 'disconnected',
      integration_id: 'int-1',
      platform_type: 'standalone',
    });
    expect(result.totals).toMatchObject({ confirmed: 3, canceled: 2 });
    expect(result.usage).toEqual({
      used: 0,
      limit: 0,
      period_start: null,
      period_end: null,
    });
    expect(repository.getEntitlementSource).not.toHaveBeenCalled();
  });
  it('rejects ambiguous active sources', async () => {
    const { service, repository } = setup([source, { ...source, id: 'int-2' }]);
    await expect(service.getStatsByOrg('org-1', {})).rejects.toThrow(
      'Multiple active commerce sources',
    );
    expect(repository.getEntitlementSource).not.toHaveBeenCalled();
  });
});
