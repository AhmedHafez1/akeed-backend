import type { ConfigService } from '@nestjs/config';
import { AdminHealthRuleService } from './admin-health-rule.service';

const baseFacts = {
  onboardingStatus: 'completed',
  installedAt: '2026-08-01T00:00:00Z',
  onboardingCompletedAt: '2026-08-01T01:00:00Z',
  firstEligibleOrderAt: '2026-08-01T02:00:00Z',
  firstResolvedAt: '2026-08-01T03:00:00Z',
  uninstalledAt: null,
  usagePercent: 20,
  failed24h: 0,
  total24h: 10,
  failedWebhooks1h: 0,
  autoEnabled: true,
  billingStatus: 'active',
  lastActivityAt: '2026-08-25T00:00:00Z',
};

describe('AdminHealthRuleService', () => {
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new AdminHealthRuleService(
    config as unknown as ConfigService,
  );
  const now = new Date('2026-08-26T00:00:00Z');

  it('returns healthy when no signal crosses a threshold', () => {
    expect(service.evaluate(baseFacts, now)).toEqual({
      status: 'healthy',
      top_signal: null,
      signal_count: 0,
    });
  });

  it('resolves any critical signal to critical', () => {
    expect(
      service.evaluate({ ...baseFacts, usagePercent: 96 }, now),
    ).toMatchObject({ status: 'critical', top_signal: 'usage_critical' });
  });

  it('honors failed-verification minimum sample sizes', () => {
    expect(
      service.evaluate({ ...baseFacts, failed24h: 9, total24h: 19 }, now)
        .status,
    ).toBe('attention_required');
    expect(
      service.evaluate({ ...baseFacts, failed24h: 9, total24h: 20 }, now)
        .status,
    ).toBe('critical');
  });
});
