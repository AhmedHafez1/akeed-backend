import { StandaloneSendReadinessService } from './standalone-send-readiness.service';
import type { StandaloneSource } from './standalone-source-resolver';

const source = {
  id: 'source-1',
  orgId: 'org-1',
  platformType: 'standalone',
  isActive: true,
  onboardingStatus: 'completed',
  isAutoVerifyEnabled: true,
} as StandaloneSource;

function setup(mode: 'prepaid_credit' | 'periodic_plan' = 'prepaid_credit') {
  const entitlements = {
    accountingModeFor: jest.fn(() => mode),
    evaluateAccess: jest.fn(() => ({ allowed: true, reason: null })),
    hasAvailableSlot: jest.fn(),
  };
  const credits = { resolveDenial: jest.fn().mockResolvedValue(null) };
  const eligibility = {
    evaluateOrderForVerification: jest.fn(() => ({
      eligible: true,
      reason: 'cod_match',
    })),
  };
  const service = new StandaloneSendReadinessService(
    entitlements as never,
    credits as never,
    eligibility as never,
  );
  return { service, entitlements, credits, eligibility };
}

function prepaid(availableCredits: number, available = availableCredits > 0) {
  return {
    available,
    reason: available ? null : 'INSUFFICIENT_CREDITS',
    consumedCount: 0,
    includedLimit: availableCredits,
    credits: { availableCredits },
  };
}

describe('StandaloneSendReadinessService', () => {
  it('is ready with the balance snapshot in prepaid mode', async () => {
    const { service, entitlements } = setup();
    entitlements.hasAvailableSlot.mockResolvedValue(prepaid(2_300));
    await expect(
      service.evaluate(source, { required: 970, mode: 'all' }),
    ).resolves.toEqual({
      ready: true,
      blockers: [],
      snapshot: {
        accountingMode: 'prepaid_credit',
        creditsAvailable: 2_300,
        slotsRemaining: null,
      },
    });
  });

  it('reports the shortfall when the balance covers one message but not N', async () => {
    const { service, entitlements } = setup();
    entitlements.hasAvailableSlot.mockResolvedValue(prepaid(400));
    const result = await service.evaluate(source, {
      required: 970,
      mode: 'all',
    });
    expect(result.blockers).toEqual([
      {
        kind: 'credit_denied',
        code: 'INSUFFICIENT_CREDITS',
        shortfall: 570,
        available: 400,
      },
    ]);
  });

  it('is ready for one message when N would be short (the manual paths)', async () => {
    const { service, entitlements } = setup();
    entitlements.hasAvailableSlot.mockResolvedValue(prepaid(1));
    await expect(
      service.evaluate(source, { required: 1 }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });
  });

  it('merges a zero-balance credit denial with its shortfall', async () => {
    const { service, entitlements, credits } = setup();
    credits.resolveDenial.mockResolvedValue('INSUFFICIENT_CREDITS');
    entitlements.hasAvailableSlot.mockResolvedValue(prepaid(0));
    const result = await service.evaluate(source, {
      required: 50,
      mode: 'all',
    });
    expect(result.blockers).toEqual([
      {
        kind: 'credit_denied',
        code: 'INSUFFICIENT_CREDITS',
        shortfall: 50,
        available: 0,
      },
      {
        kind: 'slot_unavailable',
        reason: 'INSUFFICIENT_CREDITS',
        consumedCount: 0,
        includedLimit: 0,
      },
    ]);
  });

  it.each([
    'CREDIT_DEBT_OUTSTANDING',
    'CREDIT_ACCOUNT_SUSPENDED',
    'CREDIT_ACCOUNT_NOT_PROVISIONED',
  ])('reports %s as a credit denial', async (code) => {
    const { service, entitlements, credits } = setup();
    credits.resolveDenial.mockResolvedValue(code);
    entitlements.hasAvailableSlot.mockResolvedValue(prepaid(500));
    const result = await service.evaluate(source, {
      required: 10,
      mode: 'all',
    });
    expect(result.blockers).toEqual([{ kind: 'credit_denied', code }]);
  });

  it('counts plan slots and refuses N above them in periodic mode', async () => {
    const { service, entitlements } = setup('periodic_plan');
    entitlements.hasAvailableSlot.mockResolvedValue({
      available: true,
      reason: null,
      consumedCount: 90,
      includedLimit: 100,
    });
    const result = await service.evaluate(source, {
      required: 25,
      mode: 'all',
    });
    expect(result.snapshot).toEqual({
      accountingMode: 'periodic_plan',
      creditsAvailable: null,
      slotsRemaining: 10,
    });
    expect(result.blockers).toEqual([
      {
        kind: 'slot_unavailable',
        reason: 'plan_limit_reached',
        consumedCount: 90,
        includedLimit: 100,
        slotsRemaining: 10,
      },
    ]);
    await expect(
      service.evaluate(source, { required: 10, mode: 'all' }),
    ).resolves.toMatchObject({ ready: true });
  });

  it('lists every source gate in canonical order in all mode', async () => {
    const { service, entitlements } = setup();
    entitlements.evaluateAccess.mockReturnValue({
      allowed: false,
      reason: 'integration_inactive',
    } as never);
    entitlements.hasAvailableSlot.mockResolvedValue(prepaid(10));
    const result = await service.evaluate(
      {
        ...source,
        isActive: false,
        onboardingStatus: 'pending',
        isAutoVerifyEnabled: false,
      } as StandaloneSource,
      { required: 1, mode: 'all' },
    );
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual([
      'source_inactive',
      'setup_incomplete',
      'entitlement_required',
      'auto_verify_disabled',
    ]);
  });

  it('never reads billing once a source gate fails in first mode', async () => {
    const { service, entitlements, credits } = setup();
    await service.evaluate(
      { ...source, isAutoVerifyEnabled: false } as StandaloneSource,
      { required: 1 },
    );
    expect(credits.resolveDenial).not.toHaveBeenCalled();
    expect(entitlements.hasAvailableSlot).not.toHaveBeenCalled();
  });

  it('skips the usage read after a credit denial in first mode', async () => {
    const { service, entitlements, credits } = setup();
    credits.resolveDenial.mockResolvedValue('CREDIT_ACCOUNT_SUSPENDED');
    const result = await service.evaluate(source, { required: 1 });
    expect(result.blockers).toEqual([
      { kind: 'credit_denied', code: 'CREDIT_ACCOUNT_SUSPENDED' },
    ]);
    expect(entitlements.hasAvailableSlot).not.toHaveBeenCalled();
  });

  it('judges the order only when the source itself can send', async () => {
    const { service, entitlements, eligibility } = setup();
    entitlements.hasAvailableSlot.mockResolvedValue(prepaid(10));
    eligibility.evaluateOrderForVerification.mockReturnValue({
      eligible: false,
      reason: 'non_cod_payment_method',
    });
    const order = {
      orgId: 'org-1',
      integrationId: 'source-1',
      externalOrderId: 'ext-1',
      orderNumber: null,
      customerPhone: '+201001234567',
      customerName: null,
      totalPrice: '10.00',
      currency: 'EGP',
      paymentMethod: 'card',
      rawPayload: { order: { paymentSignals: ['card'] } },
    };
    await expect(
      service.evaluate(source, { required: 1, order }),
    ).resolves.toMatchObject({
      blockers: [
        { kind: 'order_ineligible', reason: 'non_cod_payment_method' },
      ],
    });
    eligibility.evaluateOrderForVerification.mockClear();
    await service.evaluate(
      { ...source, isAutoVerifyEnabled: false } as StandaloneSource,
      { required: 1, order },
    );
    expect(eligibility.evaluateOrderForVerification).not.toHaveBeenCalled();
  });
});
