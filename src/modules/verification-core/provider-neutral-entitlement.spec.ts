import { BillingEntitlementService } from './billing-entitlement.service';
import { VerificationSendService } from './verification-send.service';
import type { EntitlementSource } from '../../shared/billing/entitlement';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

const source: EntitlementSource = {
  id: 'int-1',
  orgId: 'org-1',
  platformType: 'standalone',
  isActive: true,
  billingStatus: 'not_required',
  billingPlanId: 'starter',
  billingActivatedAt: '2026-05-01T00:00:00Z',
};

describe('provider-neutral entitlement boundary', () => {
  function setup() {
    const repository = {
      getEntitlementSource: jest.fn().mockResolvedValue(source),
      getIntegrationUsageForPeriod: jest
        .fn()
        .mockResolvedValue({ consumedCount: 29, includedLimit: 30 }),
      reserveMonthlyVerificationSlot: jest.fn().mockResolvedValue({
        allowed: true,
        reason: null,
        includedLimit: 30,
        consumedCount: 30,
        planId: 'starter',
        periodStart: '2026-05-01',
      }),
      releaseMonthlyVerificationSlot: jest.fn(),
    };
    const service = new BillingEntitlementService(repository as never);
    const messaging = {
      sendVerificationTemplate: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'synthetic-wamid' }] }),
    };
    const verifications = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'ver-1', orderId: 'order-1', orgId: 'org-1' }),
      updateByIdForOrg: jest.fn(),
    };
    const orders = {
      findById: jest.fn().mockResolvedValue({
        orgId: 'org-1',
        integrationId: 'int-1',
        integration: source,
        totalPrice: '12.00',
      }),
    };
    const dispatches = {
      claim: jest.fn().mockImplementation(async () => {
        const reservation = await repository.reserveMonthlyVerificationSlot({
          id: source.id,
          orgId: source.orgId,
        });
        if (!reservation.allowed) {
          return {
            outcome: 'blocked',
            reason: reservation.reason,
            consumedCount: reservation.consumedCount,
            includedLimit: reservation.includedLimit,
          };
        }
        return { outcome: 'claimed', dispatch: { id: 'dispatch-1' } };
      }),
      // Must resolve to the accepted ledger row: `undefined` now means the
      // verification projection did not run, and the send reports
      // `outcome_unknown` instead of claiming a send that left no trace.
      markAccepted: jest
        .fn()
        .mockResolvedValue({ id: 'dispatch-1', state: 'accepted' }),
      markOutcomeUnknown: jest.fn(),
    };
    const sender = new VerificationSendService(
      verifications as never,
      orders as never,
      service,
      dispatches as never,
      messaging,
    );
    return { repository, service, messaging, verifications, sender };
  }

  it('reads persisted state rather than trusting a caller billing snapshot', async () => {
    const { repository, service } = setup();
    repository.getEntitlementSource.mockResolvedValue({
      ...source,
      billingStatus: 'frozen',
    });
    expect(await service.hasAvailableSlot(source)).toMatchObject({
      available: false,
      reason: 'billing_not_active',
    });
    repository.getEntitlementSource.mockResolvedValue(source);
    expect(await service.hasAvailableSlot(source)).toMatchObject({
      available: true,
      includedLimit: 30,
    });
    repository.getIntegrationUsageForPeriod.mockResolvedValue({
      consumedCount: 30,
      includedLimit: 30,
    });
    expect(await service.hasAvailableSlot(source)).toMatchObject({
      available: false,
      reason: 'plan_limit_reached',
    });
  });

  it('sends a provisioned manual verification without a Shopify dependency', async () => {
    const { sender, repository, messaging } = setup();
    expect(await sender.sendInitial('ver-1')).toMatchObject({ status: 'sent' });
    expect(repository.reserveMonthlyVerificationSlot).toHaveBeenCalledWith({
      id: source.id,
      orgId: source.orgId,
    });
    expect(messaging.sendVerificationTemplate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'integration_inactive',
    'billing_not_active',
    'missing_linked_integration',
  ])(
    'does not send when the locked reservation denies %s after context loading',
    async (reason) => {
      const { sender, repository, messaging } = setup();
      repository.reserveMonthlyVerificationSlot.mockResolvedValue({
        allowed: false,
        reason,
        consumedCount: 0,
      });
      expect(await sender.sendInitial('ver-1')).toEqual({
        status: 'skipped',
        reason,
      });
      expect(messaging.sendVerificationTemplate).not.toHaveBeenCalled();
      expect(repository.releaseMonthlyVerificationSlot).not.toHaveBeenCalled();
    },
  );

  it('retains the original reservation when provider acceptance is unknown', async () => {
    const { sender, repository, messaging } = setup();
    messaging.sendVerificationTemplate.mockRejectedValue(
      new Error('synthetic failure'),
    );
    expect(await sender.sendFollowUp('ver-1')).toMatchObject({
      status: 'outcome_unknown',
    });
    expect(repository.releaseMonthlyVerificationSlot).not.toHaveBeenCalled();
  });
});
