import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseStandaloneBillingObservabilityConfig,
  STANDALONE_BILLING_OBSERVABILITY_CONFIG,
} from '../../shared/config/standalone-billing-observability.config';
import {
  parseStandaloneCreditBillingConfig,
  STANDALONE_CREDIT_BILLING_CONFIG,
} from '../../shared/config/standalone-credit-billing.config';
import { BillingObservabilityService } from './billing-observability.service';

type Facts = {
  openCount?: number;
  criticalCount?: number;
  oldestMinutes?: number;
  attempts?: number;
  failures?: number;
};

function setup(facts: Facts = {}) {
  const oldestOpenAt =
    facts.oldestMinutes === undefined
      ? null
      : new Date(Date.now() - facts.oldestMinutes * 60_000).toISOString();
  const repository = {
    healthFacts: jest.fn().mockResolvedValue({
      purchases: {
        checkoutStarts: 0,
        successfulPurchases: 0,
        payingOrganizations: 0,
        purchasedCredits: 0,
        grossMinor: 0,
        firstPurchases: 0,
        repeatPurchases: 0,
        averagePurchaseCredits: 0,
      },
      accounts: {
        activatedOrganizations: 0,
        lowBalanceOrganizations: 0,
        zeroBalanceOrganizations: 0,
      },
      ledger: {
        launchGrants: 0,
        freeCredits: 0,
        initialConsumption: 0,
        followUpConsumption: 0,
        failureReversals: 0,
        refundedMinor: 0,
        chargebackMinor: 0,
      },
      findings: {
        openCount: facts.openCount ?? 0,
        criticalCount: facts.criticalCount ?? 0,
        oldestOpenAt,
      },
      provider: {
        attempts: facts.attempts ?? 0,
        failures: facts.failures ?? 0,
        slow: 0,
        averageDurationMs: 0,
      },
      purchaseStates: [],
      purchaseSizes: [],
      firstAccepted: { averageSeconds: null, sampleSize: 0 },
    }),
    effectiveSettlementTotals: jest.fn().mockResolvedValue({
      reports: 0,
      periodStart: null,
      periodEnd: null,
      feeMinor: 0,
      vatMinor: 0,
      netMinor: 0,
    }),
    latestRun: jest.fn().mockResolvedValue(undefined),
    liabilityLedger: jest.fn().mockResolvedValue([]),
    claimRun: jest.fn().mockResolvedValue(true),
    run: jest.fn().mockResolvedValue({ id: 'run-1', attempted: 0 }),
    organizationIds: jest.fn().mockResolvedValue([]),
    staticSignals: jest.fn().mockResolvedValue([
      {
        code: 'credit_debt',
        severity: 'attention',
        nextAction: 'resolve_debt',
        orgId: '00000000-0000-4000-8000-000000000001',
        purchaseId: null,
        identity: '00000000-0000-4000-8000-000000000001',
        errorCode: null,
      },
    ]),
    hasAttempt: jest.fn().mockResolvedValue(false),
    recordAttempt: jest.fn().mockResolvedValue(true),
    upsertFinding: jest.fn().mockResolvedValue('opened'),
    candidates: jest.fn().mockResolvedValue([]),
    resolveUnseen: jest.fn().mockResolvedValue(0),
    cleanup: jest.fn().mockResolvedValue(undefined),
    finishRun: jest.fn().mockResolvedValue(undefined),
  };
  const config = new ConfigService({
    [STANDALONE_BILLING_OBSERVABILITY_CONFIG]:
      parseStandaloneBillingObservabilityConfig({}),
    [STANDALONE_CREDIT_BILLING_CONFIG]: parseStandaloneCreditBillingConfig({}),
  });
  const service = new BillingObservabilityService(
    repository as never,
    { readReconciliation: jest.fn() } as never,
    { reconcile: jest.fn() } as never,
    { enqueue: jest.fn() } as never,
    { record: jest.fn() } as never,
    config,
  );
  return { repository, service };
}

describe('BillingObservabilityService health thresholds', () => {
  it.each([
    [{}, 'healthy', false],
    [{ openCount: 24, oldestMinutes: 119 }, 'healthy', false],
    [{ openCount: 25, oldestMinutes: 1 }, 'attention', true],
    [{ openCount: 1, oldestMinutes: 120 }, 'attention', true],
    [{ openCount: 1, criticalCount: 1, oldestMinutes: 1 }, 'critical', false],
  ] as const)(
    'rates backlog %o as %s',
    async (facts: Facts, status, backlogAlert) => {
      const { health } = await setup(facts).service.health();
      expect(health).toMatchObject({ status, backlogAlert });
    },
  );

  it.each([
    [{ attempts: 5, failures: 1 }, true, 20],
    [{ attempts: 5, failures: 0 }, false, 0],
    [{ attempts: 4, failures: 4 }, false, 100],
    [{ attempts: 10, failures: 1 }, false, 10],
  ] as const)(
    'rates Paymob %o degraded=%s',
    async (facts: Facts, degraded, errorRatePercent) => {
      const { health } = await setup(facts).service.health();
      expect(health.provider).toMatchObject({ degraded, errorRatePercent });
      expect(health.status).toBe(degraded ? 'attention' : 'healthy');
    },
  );

  it('reports rollout switches and leaves settlement values unavailable without a bounded range', async () => {
    const report = await setup().service.health();
    expect(report.health).toMatchObject({
      scheduledInquiryEnabled: false,
      reportOnly: true,
      cron: '30 2 * * *',
      timezone: 'Africa/Cairo',
    });
    expect(report.settlementCoverage.complete).toBe(false);
    expect(report.finance).toMatchObject({
      netRevenueMinor: null,
      feeMinor: null,
      vatMinor: null,
      arppuMinor: null,
      revenuePerAcceptedMessageMinor: null,
    });
  });
});

describe('BillingObservabilityService alerts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('emits one bounded alert per newly opened finding and a metric summary', async () => {
    const { service } = setup({ openCount: 25, oldestMinutes: 3 });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    await service.processRun('run-1');

    const alerts = warn.mock.calls.map(
      ([line]) => JSON.parse(line as string) as Record<string, unknown>,
    );
    expect(alerts).toEqual([
      expect.objectContaining({
        action: 'standalone-billing-alert',
        alertCode: 'credit_debt',
        severity: 'attention',
        orgId: '00000000-0000-4000-8000-000000000001',
      }),
      expect.objectContaining({
        action: 'standalone-billing-alert',
        alertCode: 'reconciliation_backlog',
        openFindings: 25,
      }),
    ]);
    const summary = JSON.parse(log.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      action: 'standalone-billing-metric-summary',
      runId: 'run-1',
      findingsOpened: 1,
    });
    // Counters only: no organization or provider reference as a dimension.
    expect(Object.keys(summary)).not.toEqual(
      expect.arrayContaining(['orgId', 'reference', 'purchaseId']),
    );
  });

  it('stays quiet when an already-open finding is seen again', async () => {
    const { service, repository } = setup();
    repository.upsertFinding.mockResolvedValue('updated');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await service.processRun('run-1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('records the failure and rethrows without resolving anything', async () => {
    const { service, repository } = setup();
    repository.staticSignals.mockRejectedValueOnce(new Error('db down'));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await expect(service.processRun('run-1')).rejects.toThrow('db down');
    expect(repository.resolveUnseen).not.toHaveBeenCalled();
    expect(repository.finishRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.anything(),
    );
    expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({
      action: 'billing-reconciliation-run',
      outcome: 'failure',
    });
  });

  it('does nothing for a run another worker already completed', async () => {
    const { service, repository } = setup();
    repository.claimRun.mockResolvedValue(false);
    await service.processRun('run-1');
    expect(repository.organizationIds).not.toHaveBeenCalled();
    expect(repository.finishRun).not.toHaveBeenCalled();
  });
});
