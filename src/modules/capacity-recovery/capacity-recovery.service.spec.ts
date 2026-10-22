/* eslint-disable @typescript-eslint/require-await -- the in-memory fakes keep the async signatures of the repositories they replace. */
import type { ConfigService } from '@nestjs/config';
import type { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import type { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import { USAGE_ALERTS_CONFIG } from '../../shared/config/usage-alerts.config';
import type { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import type { UsageAlertService } from '../verification-core/usage-alert.service';
import type { VerificationHubService } from '../verification-core/verification-hub.service';
import { CAPACITY_RECOVERY_BATCH } from './capacity-recovery.constants';
import { CapacityRecoveryService } from './capacity-recovery.service';

const NOW = new Date('2026-10-22T12:00:00.000Z');

const SOURCE = {
  id: 'int-1',
  orgId: 'org-1',
  isActive: true,
  isAutoVerifyEnabled: true,
  onboardingStatus: 'completed',
};

function candidate(index: number, hoursOld = 1) {
  return {
    verificationId: `ver-${index}`,
    orderId: `ord-${index}`,
    integrationId: 'int-1',
    reason: 'INSUFFICIENT_CREDITS',
    orderCreatedAt: new Date(
      NOW.getTime() - hoursOld * 3_600_000,
    ).toISOString(),
  };
}

function setup(candidates: ReturnType<typeof candidate>[]) {
  const statuses = new Map<string, string>(
    candidates.map((row) => [row.verificationId, 'blocked']),
  );
  let slots = Number.POSITIVE_INFINITY;
  const verificationsRepo = {
    listCapacityRecoveryCandidates: jest.fn(async () => candidates),
    markCapacityBlockUnsent: jest.fn(
      async ({ verificationId }: { verificationId: string }) => {
        statuses.set(verificationId, 'failed');
        return true;
      },
    ),
    reopenRetryableInitialFailure: jest.fn(async (verificationId: string) => {
      if (statuses.get(verificationId) !== 'blocked') return false;
      statuses.set(verificationId, 'pending');
      return true;
    }),
    findById: jest.fn(async (id: string) => ({ id, status: statuses.get(id) })),
  };
  const sources = [{ ...SOURCE }];
  const integrationsRepo = {
    findActiveByOrg: jest.fn(async () => sources),
  };
  const entitlements = {
    hasAvailableSlot: jest.fn(async () =>
      slots > 0
        ? { available: true, reason: null }
        : { available: false, reason: 'INSUFFICIENT_CREDITS' },
    ),
    evaluateAccess: jest.fn(() => ({ reason: null as string | null })),
  };
  const hub = {
    resumeInitialSend: jest.fn(async (verificationId: string) => {
      slots -= 1;
      statuses.set(verificationId, 'sent');
    }),
  };
  const usageAlerts = { evaluateOrg: jest.fn(async () => undefined) };
  const config = {
    get: jest.fn((key: string) =>
      key === USAGE_ALERTS_CONFIG
        ? {
            emailEnabled: false,
            resendApiKey: null,
            emailFrom: null,
            dashboardUrl: null,
            recoveryEnabled: true,
            blockedOrderMaxAgeHours: 24,
          }
        : undefined,
    ),
  };
  const service = new CapacityRecoveryService(
    verificationsRepo as unknown as VerificationsRepository,
    integrationsRepo as unknown as IntegrationsRepository,
    entitlements as unknown as BillingEntitlementService,
    hub as unknown as VerificationHubService,
    usageAlerts as unknown as UsageAlertService,
    config as unknown as ConfigService,
  );
  return {
    service,
    statuses,
    sources,
    verificationsRepo,
    entitlements,
    hub,
    usageAlerts,
    setSlots: (value: number) => {
      slots = value;
    },
  };
}

describe('CapacityRecoveryService', () => {
  it('resumes blocked orders oldest first through the send path', async () => {
    const { service, hub, verificationsRepo, usageAlerts } = setup([
      candidate(1, 5),
      candidate(2, 3),
    ]);

    const result = await service.recover('org-1', NOW);

    expect(result).toMatchObject({ resumed: 2, exhausted: false, more: false });
    expect(hub.resumeInitialSend.mock.calls.map(([id]) => id)).toEqual([
      'ver-1',
      'ver-2',
    ]);
    expect(hub.resumeInitialSend).toHaveBeenCalledWith(
      'ver-1',
      { id: 'ord-1', orgId: 'org-1' },
      expect.objectContaining({ id: 'int-1' }),
    );
    expect(
      verificationsRepo.listCapacityRecoveryCandidates,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        legacyFailedSince: '2026-10-21T12:00:00.000Z',
        limit: CAPACITY_RECOVERY_BATCH,
      }),
    );
    expect(usageAlerts.evaluateOrg).toHaveBeenCalledWith('org-1');
  });

  it('stops when capacity runs out and leaves the rest blocked', async () => {
    const { service, hub, statuses, setSlots } = setup([
      candidate(1),
      candidate(2),
      candidate(3),
    ]);
    setSlots(2);

    const result = await service.recover('org-1', NOW);

    expect(result).toMatchObject({ resumed: 2, exhausted: true, more: false });
    expect(hub.resumeInitialSend).toHaveBeenCalledTimes(2);
    expect(statuses.get('ver-3')).toBe('blocked');
  });

  it('sends nothing while there is no capacity', async () => {
    const { service, hub, verificationsRepo, setSlots } = setup([candidate(1)]);
    setSlots(0);

    const result = await service.recover('org-1', NOW);

    expect(result.exhausted).toBe(true);
    expect(
      verificationsRepo.reopenRetryableInitialFailure,
    ).not.toHaveBeenCalled();
    expect(hub.resumeInitialSend).not.toHaveBeenCalled();
  });

  it('moves a stale order to the needs-action list without sending it', async () => {
    const { service, hub, verificationsRepo } = setup([
      candidate(1, 25),
      candidate(2, 2),
    ]);

    const result = await service.recover('org-1', NOW);

    expect(result).toMatchObject({ stale: 1, resumed: 1 });
    expect(verificationsRepo.markCapacityBlockUnsent).toHaveBeenCalledWith({
      verificationId: 'ver-1',
      orgId: 'org-1',
      reason: 'capacity_block_stale',
      blockedReason: 'INSUFFICIENT_CREDITS',
    });
    expect(hub.resumeInitialSend.mock.calls.map(([id]) => id)).toEqual([
      'ver-2',
    ]);
  });

  it('skips an order another worker reopened first', async () => {
    const { service, hub, statuses } = setup([candidate(1), candidate(2)]);
    statuses.set('ver-1', 'pending');

    const result = await service.recover('org-1', NOW);

    expect(result).toMatchObject({ raced: 1, resumed: 1 });
    expect(hub.resumeInitialSend.mock.calls.map(([id]) => id)).toEqual([
      'ver-2',
    ]);
  });

  it('stops when the send path blocks the order again', async () => {
    const { service, hub, statuses } = setup([candidate(1), candidate(2)]);
    hub.resumeInitialSend.mockImplementationOnce(async (id: string) => {
      statuses.set(id, 'blocked');
    });

    const result = await service.recover('org-1', NOW);

    expect(result).toMatchObject({ resumed: 0, exhausted: true });
    expect(hub.resumeInitialSend).toHaveBeenCalledTimes(1);
  });

  it('keeps orders waiting while their source cannot send', async () => {
    const { service, hub, sources, entitlements } = setup([candidate(1)]);
    sources[0].isAutoVerifyEnabled = false;
    let result = await service.recover('org-1', NOW);
    expect(result.waiting).toBe(1);

    sources[0].isAutoVerifyEnabled = true;
    entitlements.evaluateAccess.mockReturnValue({
      reason: 'billing_not_active',
    });
    result = await service.recover('org-1', NOW);
    expect(result.waiting).toBe(1);

    sources.length = 0;
    result = await service.recover('org-1', NOW);
    expect(result.waiting).toBe(1);
    expect(hub.resumeInitialSend).not.toHaveBeenCalled();
  });

  it('asks for another run when the batch was full', async () => {
    const { service } = setup(
      Array.from({ length: CAPACITY_RECOVERY_BATCH }, (_, index) =>
        candidate(index),
      ),
    );

    const result = await service.recover('org-1', NOW);

    expect(result).toMatchObject({
      resumed: CAPACITY_RECOVERY_BATCH,
      more: true,
    });
  });

  it('never sends an order twice when two runs overlap', async () => {
    const { service, hub } = setup([candidate(1), candidate(2)]);

    await Promise.all([
      service.recover('org-1', NOW),
      service.recover('org-1', NOW),
    ]);

    expect(hub.resumeInitialSend.mock.calls.map(([id]) => id).sort()).toEqual([
      'ver-1',
      'ver-2',
    ]);
  });
});
