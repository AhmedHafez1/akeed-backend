/* eslint-disable @typescript-eslint/require-await -- the in-memory fakes keep the async signatures of the repositories they replace. */
import type { ConfigService } from '@nestjs/config';
import type { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import type { UsageAlertsRepository } from '../../infrastructure/database/repositories/usage-alerts.repository';
import type { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import type { EmailPort } from '../../shared/ports/email.port';
import { STANDALONE_CREDIT_BILLING_CONFIG } from '../../shared/config/standalone-credit-billing.config';
import { USAGE_ALERTS_CONFIG } from '../../shared/config/usage-alerts.config';
import type { BillingEntitlementService } from './billing-entitlement.service';
import { UsageAlertService } from './usage-alert.service';

interface AlertRow {
  id: string;
  orgId: string;
  integrationId: string;
  kind: string;
  level: string;
  cycleKey: string;
  emailStatus: string;
  emailError: string | null;
  resolved: boolean;
}

/** The two unique indexes of `usage_alerts`, kept in memory. */
function createAlertStore() {
  const rows: AlertRow[] = [];
  let next = 0;
  const repo = {
    claim: jest.fn(
      async (params: {
        orgId: string;
        integrationId: string;
        kind: string;
        level: string;
        cycleKey: string;
      }) => {
        const taken = rows.some((row) =>
          params.kind === 'plan_usage'
            ? row.kind === 'plan_usage' &&
              row.integrationId === params.integrationId &&
              row.level === params.level &&
              row.cycleKey === params.cycleKey
            : row.kind === 'credit_balance' &&
              row.orgId === params.orgId &&
              row.level === params.level &&
              !row.resolved,
        );
        if (taken) return null;
        const id = `alert-${++next}`;
        rows.push({
          ...params,
          id,
          emailStatus: 'pending',
          emailError: null,
          resolved: false,
        });
        return id;
      },
    ),
    markEmail: jest.fn(
      async (id: string, status: string, error?: string | null) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) {
          row.emailStatus = status;
          row.emailError = error ?? null;
        }
      },
    ),
    resolveOpenCreditAlerts: jest.fn(
      async (orgId: string, levels: string[]) => {
        for (const row of rows) {
          if (
            row.orgId === orgId &&
            row.kind === 'credit_balance' &&
            levels.includes(row.level)
          ) {
            row.resolved = true;
          }
        }
      },
    ),
    findOwnerEmail: jest.fn(async () => 'owner@example.test' as string | null),
  };
  return { rows, repo };
}

const PLAN_SOURCE = {
  id: 'int-1',
  orgId: 'org-1',
  storeName: 'Nile Shop',
  notificationEmail: null as string | null,
  defaultLanguage: 'en',
};

function planEntitlement(consumedCount: number, periodStart = '2026-10-01') {
  return {
    allowed: true,
    consumedCount,
    includedLimit: 100,
    planId: 'growth',
    periodStart,
    periodEnd: '2026-10-31',
  };
}

function creditEntitlement(availableCredits: number) {
  return {
    allowed: availableCredits >= 1,
    credits: { status: 'active', availableCredits },
  };
}

function setup(options: { mode?: 'plan' | 'prepaid_credit' } = {}) {
  const mode = options.mode ?? 'plan';
  const store = createAlertStore();
  const sources = [{ ...PLAN_SOURCE }];
  const integrationsRepo = {
    findActiveByOrg: jest.fn(async () => sources),
  };
  const entitlements = {
    accountingModeFor: jest.fn(() =>
      mode === 'plan' ? 'periodic_plan' : 'prepaid_credit',
    ),
    readEntitlement: jest.fn(),
  };
  const verificationsRepo = { countBlocked: jest.fn(async () => 3) };
  const email = {
    send: jest.fn(async () => ({ status: 'sent' as const })),
  };
  const settings: Record<string, unknown> = {
    [STANDALONE_CREDIT_BILLING_CONFIG]: { lowBalanceThreshold: 10 },
    [USAGE_ALERTS_CONFIG]: {
      emailEnabled: true,
      resendApiKey: 're_test',
      emailFrom: 'alerts@example.test',
      dashboardUrl: 'https://app.example.test/dashboard',
      recoveryEnabled: true,
      blockedOrderMaxAgeHours: 24,
    },
  };
  const config = { get: jest.fn((key: string) => settings[key]) };
  const service = new UsageAlertService(
    integrationsRepo as unknown as IntegrationsRepository,
    entitlements as unknown as BillingEntitlementService,
    verificationsRepo as unknown as VerificationsRepository,
    store.repo as unknown as UsageAlertsRepository,
    config as unknown as ConfigService,
    email as unknown as EmailPort,
  );
  return { service, store, sources, entitlements, email, verificationsRepo };
}

function subjects(email: { send: jest.Mock }): string[] {
  return (email.send.mock.calls as unknown as [{ subject: string }][]).map(
    ([message]) => message.subject,
  );
}

describe('UsageAlertService plan usage', () => {
  it('emails once when 80% is reached and not again in the same period', async () => {
    const { service, store, entitlements, email } = setup();
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(80));

    await service.evaluateOrg('org-1');
    await service.evaluateOrg('org-1');

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.test',
        subject: 'You have used 80% of your Akeed confirmations',
        idempotencyKey: 'usage-alert-alert-1',
      }),
    );
    expect(store.rows).toEqual([
      expect.objectContaining({ level: '80', emailStatus: 'sent' }),
    ]);
  });

  it('stays quiet under 80%', async () => {
    const { service, store, entitlements, email } = setup();
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(79));

    await service.evaluateOrg('org-1');

    expect(email.send).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it('emails each higher level as usage climbs', async () => {
    const { service, entitlements, email } = setup();
    for (const used of [80, 90, 95, 100]) {
      entitlements.readEntitlement.mockResolvedValue(planEntitlement(used));
      await service.evaluateOrg('org-1');
    }

    expect(subjects(email)).toEqual([
      'You have used 80% of your Akeed confirmations',
      'You have used 95% of your Akeed confirmations',
      'Akeed has paused order confirmations',
    ]);
  });

  it('records skipped levels on a jump and emails only the highest', async () => {
    const { service, store, entitlements, email } = setup();
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(100));

    await service.evaluateOrg('org-1');

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(
      store.rows.map((row) => [row.level, row.emailStatus, row.emailError]),
    ).toEqual([
      ['80', 'skipped', 'superseded'],
      ['95', 'skipped', 'superseded'],
      ['100', 'sent', null],
    ]);
  });

  it('alerts again in a new billing period', async () => {
    const { service, entitlements, email } = setup();
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(80));
    await service.evaluateOrg('org-1');
    entitlements.readEntitlement.mockResolvedValue(
      planEntitlement(80, '2026-10-31'),
    );
    await service.evaluateOrg('org-1');

    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('includes the blocked count, the action and the reset date', async () => {
    const { service, entitlements, email } = setup();
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(100));

    await service.evaluateOrg('org-1');

    const [[message]] = email.send.mock.calls as unknown as [
      [{ text: string }],
    ];
    expect(message.text).toContain('3 orders are waiting');
    expect(message.text).toContain('Upgrade your plan');
    expect(message.text).toContain('2026-10-31');
    expect(message.text).toContain('https://app.example.test/dashboard');
  });

  it('ignores a source refused for a reason other than capacity', async () => {
    const { service, store, entitlements, email } = setup();
    entitlements.readEntitlement.mockResolvedValue({
      ...planEntitlement(100),
      allowed: false,
    });

    await service.evaluateOrg('org-1');

    expect(store.rows).toHaveLength(0);
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe('UsageAlertService credits', () => {
  it('alerts once per low-balance incident and again after a recovery', async () => {
    const { service, store, entitlements, email } = setup({
      mode: 'prepaid_credit',
    });
    entitlements.readEntitlement.mockResolvedValue(creditEntitlement(8));
    await service.evaluateOrg('org-1');
    entitlements.readEntitlement.mockResolvedValue(creditEntitlement(5));
    await service.evaluateOrg('org-1');
    expect(email.send).toHaveBeenCalledTimes(1);

    entitlements.readEntitlement.mockResolvedValue(creditEntitlement(500));
    await service.evaluateOrg('org-1');
    expect(store.rows[0].resolved).toBe(true);

    entitlements.readEntitlement.mockResolvedValue(creditEntitlement(9));
    await service.evaluateOrg('org-1');
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('alerts when credits run out after a low alert', async () => {
    const { service, entitlements, email } = setup({ mode: 'prepaid_credit' });
    entitlements.readEntitlement.mockResolvedValue(creditEntitlement(4));
    await service.evaluateOrg('org-1');
    entitlements.readEntitlement.mockResolvedValue(creditEntitlement(0));
    await service.evaluateOrg('org-1');

    expect(subjects(email)).toEqual([
      'Your Akeed credits are running low',
      'Akeed has paused order confirmations',
    ]);
  });

  it('evaluates org credits once however many sources share them', async () => {
    const { service, sources, entitlements } = setup({
      mode: 'prepaid_credit',
    });
    sources.push({ ...PLAN_SOURCE, id: 'int-2' });
    entitlements.readEntitlement.mockResolvedValue(creditEntitlement(500));

    await service.evaluateOrg('org-1');

    expect(entitlements.readEntitlement).toHaveBeenCalledTimes(1);
  });
});

describe('UsageAlertService delivery', () => {
  it('writes to the store email when the store reported one', async () => {
    const { service, sources, store, entitlements, email } = setup();
    sources[0].notificationEmail = 'shop@example.test';
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(80));

    await service.evaluateOrg('org-1');

    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'shop@example.test' }),
    );
    expect(store.repo.findOwnerEmail).not.toHaveBeenCalled();
  });

  it('records a skipped email when there is nobody to write to', async () => {
    const { service, store, entitlements, email } = setup();
    store.repo.findOwnerEmail.mockResolvedValue(null);
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(80));

    await service.evaluateOrg('org-1');

    expect(email.send).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({
      emailStatus: 'skipped',
      emailError: 'no_recipient',
    });
  });

  it('records a provider failure without retrying or throwing', async () => {
    const { service, store, entitlements, email } = setup();
    email.send.mockResolvedValue({
      status: 'failed',
      reason: 'provider_status_500',
    } as never);
    entitlements.readEntitlement.mockResolvedValue(planEntitlement(80));

    await service.evaluateOrg('org-1');
    await service.evaluateOrg('org-1');

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({
      emailStatus: 'failed',
      emailError: 'provider_status_500',
    });
  });

  it('never throws when reading usage fails', async () => {
    const { service, entitlements } = setup();
    entitlements.readEntitlement.mockRejectedValue(new Error('db down'));

    await expect(service.evaluateOrg('org-1')).resolves.toBeUndefined();
  });
});
