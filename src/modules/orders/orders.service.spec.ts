import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  type ManualOrderAcceptanceInput,
  ManualOrderPayloadConflictError,
} from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';
import { OrdersService } from './orders.service';

describe('OrdersService manual creation', () => {
  const source = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    platformStoreUrl: 'standalone:org-1',
    isActive: true,
    onboardingStatus: 'completed',
    billingPlanId: 'starter',
    billingStatus: 'not_required',
    billingActivatedAt: '2026-09-01T00:00:00.000Z',
    isAutoVerifyEnabled: true,
  };
  const payload = {
    customerPhone: '+201001234567',
    customerName: 'Customer',
    orderNumber: 'ORD-1',
    totalPrice: '125.5',
    currency: 'EGP' as const,
    paymentMethod: 'cash_on_delivery',
  };
  const owner: AuthenticatedUser = {
    userId: 'user-1',
    orgId: 'org-1',
    role: 'owner',
    source: 'supabase',
  };
  const integrations = {
    findActiveByOrg: jest.fn<Promise<(typeof source)[]>, [string]>(),
  };
  const verifications = {
    findByOrderId: jest.fn<Promise<{ id: string } | undefined>, [string]>(),
  };
  const manualOrders = {
    accept: jest.fn<
      Promise<{
        eventId: string;
        order: { id: string };
        duplicate: boolean;
      }>,
      [ManualOrderAcceptanceInput]
    >(),
  };
  const phone = { standardize: jest.fn<string, [string]>() };
  const entitlements = {
    evaluateAccess: jest.fn<
      { allowed: boolean; reason: string | null },
      [unknown, unknown]
    >(),
    hasAvailableSlot: jest.fn<
      Promise<{
        available: boolean;
        reason: string | null;
        consumedCount: number;
        includedLimit: number;
      }>,
      [unknown]
    >(),
  };
  const dispatcher = {
    dispatchById: jest.fn<Promise<string>, [string]>(),
  };
  const webhookEvents = {
    resetForRedispatch: jest.fn(),
  };
  const orderEligibility = {
    evaluateOrderForVerification: jest.fn(),
  };
  let service: OrdersService;

  beforeEach(() => {
    jest.clearAllMocks();
    integrations.findActiveByOrg.mockResolvedValue([source]);
    phone.standardize.mockReturnValue('+201001234567');
    entitlements.evaluateAccess.mockReturnValue({
      allowed: true,
      reason: null,
    });
    entitlements.hasAvailableSlot.mockResolvedValue({
      available: true,
      reason: null,
      consumedCount: 4,
      includedLimit: 30,
    });
    manualOrders.accept.mockResolvedValue({
      eventId: 'event-1',
      order: { id: 'order-1' },
      duplicate: false,
    });
    dispatcher.dispatchById.mockResolvedValue('dispatched');
    verifications.findByOrderId.mockResolvedValue(undefined);
    service = new OrdersService(
      {} as never,
      integrations as never,
      verifications as never,
      manualOrders as never,
      phone as never,
      entitlements as never,
      dispatcher as never,
      webhookEvents as never,
      orderEligibility as never,
    );
  });

  it.each(['owner', 'admin'] as const)(
    'accepts a canonical order for a %s and derives trusted source identity',
    async (role) => {
      await expect(
        service.createManualOrder({ ...owner, role }, 'submission-key-123', {
          ...payload,
          orgId: 'org-forged',
          integrationId: 'int-forged',
          role: 'owner',
        } as never),
      ).resolves.toEqual({
        orderId: 'order-1',
        status: 'accepted',
        duplicate: false,
      });

      expect(integrations.findActiveByOrg).toHaveBeenCalledWith('org-1');
      const accepted = manualOrders.accept.mock.calls[0][0];
      expect(accepted.event).toMatchObject({
        orgId: 'org-1',
        integrationId: 'int-1',
        storeDomain: 'standalone:org-1',
        idempotencyKey: 'submission-key-123',
      });
      expect(accepted.order).toMatchObject({
        orgId: 'org-1',
        integrationId: 'int-1',
        totalPrice: '125.50',
        currency: 'EGP',
        paymentMethod: 'cash_on_delivery',
        isTest: false,
      });
      expect(accepted.order.externalOrderId).toMatch(/^manual-[a-f0-9]{40}$/);
      expect(JSON.stringify(accepted)).not.toContain('org-forged');
      expect(JSON.stringify(accepted)).not.toContain('int-forged');
      expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
    },
  );

  it('denies viewers before validation, source lookup, persistence, or dispatch', async () => {
    await expect(
      service.createManualOrder(
        { ...owner, role: 'viewer' },
        undefined,
        payload,
      ),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_ROLE_REQUIRED' },
    });
    expect(phone.standardize).not.toHaveBeenCalled();
    expect(integrations.findActiveByOrg).not.toHaveBeenCalled();
    expect(manualOrders.accept).not.toHaveBeenCalled();
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED'],
    ['short', 'MANUAL_ORDER_VALIDATION_FAILED'],
    ['invalid key spaces', 'MANUAL_ORDER_VALIDATION_FAILED'],
  ])('rejects invalid idempotency key %p', async (key, code) => {
    await expect(
      service.createManualOrder(owner, key, payload),
    ).rejects.toMatchObject({ response: { code } });
    expect(manualOrders.accept).not.toHaveBeenCalled();
  });

  it('returns a field error for a phone that cannot be normalized', async () => {
    phone.standardize.mockImplementation(() => {
      throw new InvalidPhoneNumberError('Phone number is invalid.');
    });
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: {
        code: 'MANUAL_ORDER_VALIDATION_FAILED',
        fieldErrors: { customerPhone: 'Phone number is invalid.' },
      },
    });
    expect(manualOrders.accept).not.toHaveBeenCalled();
  });

  it('fails closed for missing, ambiguous, non-Standalone, and unready sources', async () => {
    integrations.findActiveByOrg.mockResolvedValueOnce([]);
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_SOURCE_UNAVAILABLE' },
    });

    integrations.findActiveByOrg.mockResolvedValueOnce([source, { ...source }]);
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_SOURCE_AMBIGUOUS' },
    });

    integrations.findActiveByOrg.mockResolvedValueOnce([
      { ...source, platformType: 'shopify' },
    ]);
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_SOURCE_UNSUPPORTED' },
    });

    integrations.findActiveByOrg.mockResolvedValueOnce([
      { ...source, onboardingStatus: 'pending' },
    ]);
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_SETUP_INCOMPLETE' },
    });
    expect(manualOrders.accept).not.toHaveBeenCalled();
  });

  it('requires an active entitlement before durable acceptance', async () => {
    entitlements.evaluateAccess.mockReturnValue({
      allowed: false,
      reason: 'billing_not_active',
    });
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: {
        code: 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
        reason: 'billing_not_active',
      },
    });
    expect(manualOrders.accept).not.toHaveBeenCalled();
  });

  it('rejects creation when automatic verification is disabled', async () => {
    integrations.findActiveByOrg.mockResolvedValue([
      { ...source, isAutoVerifyEnabled: false },
    ]);

    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_AUTO_VERIFY_DISABLED' },
    });
    expect(entitlements.hasAvailableSlot).not.toHaveBeenCalled();
    expect(manualOrders.accept).not.toHaveBeenCalled();
  });

  it('rejects creation when the included plan limit is reached', async () => {
    entitlements.hasAvailableSlot.mockResolvedValue({
      available: false,
      reason: 'plan_limit_reached',
      consumedCount: 30,
      includedLimit: 30,
    });

    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: {
        code: 'MANUAL_ORDER_PLAN_LIMIT_REACHED',
        consumedCount: 30,
        includedLimit: 30,
      },
    });
    expect(manualOrders.accept).not.toHaveBeenCalled();
  });

  it('replays a matching accepted order and returns a later verification id', async () => {
    manualOrders.accept.mockResolvedValue({
      eventId: 'event-1',
      order: { id: 'order-1' },
      duplicate: true,
    });
    verifications.findByOrderId.mockResolvedValue({ id: 'verification-1' });
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).resolves.toEqual({
      orderId: 'order-1',
      verificationId: 'verification-1',
      status: 'accepted',
      duplicate: true,
    });
  });

  it('normalizes semantically equal decimal retries to the same fingerprint', async () => {
    await service.createManualOrder(owner, 'submission-key-123', payload);
    await service.createManualOrder(owner, 'submission-key-123', {
      ...payload,
      totalPrice: '125.50',
    });
    const first = manualOrders.accept.mock.calls[0][0].event;
    const second = manualOrders.accept.mock.calls[1][0].event;
    expect(first.submissionFingerprint).toBe(second.submissionFingerprint);
    expect(first.rawPayload).toEqual(second.rawPayload);
  });

  it('returns a stable conflict without dispatching changed content', async () => {
    manualOrders.accept.mockRejectedValue(
      new ManualOrderPayloadConflictError(),
    );
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_IDEMPOTENCY_CONFLICT' },
    });
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });

  it('returns accepted after a queue failure because the intent is durable', async () => {
    dispatcher.dispatchById.mockRejectedValue(new Error('Redis unavailable'));
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).resolves.toEqual({
      orderId: 'order-1',
      status: 'accepted',
      duplicate: false,
    });
  });

  it('does not claim acceptance when the atomic database write fails', async () => {
    manualOrders.accept.mockRejectedValue(new Error('database unavailable'));
    await expect(
      service.createManualOrder(owner, 'submission-key-123', payload),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_ACCEPTANCE_FAILED' },
    });
    expect(dispatcher.dispatchById).not.toHaveBeenCalled();
  });
});

describe('OrdersService manual verification lifecycle', () => {
  const user: AuthenticatedUser = {
    userId: 'owner-1',
    orgId: 'org-1',
    role: 'owner',
    source: 'supabase',
  };
  const integration = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    isActive: true,
    onboardingStatus: 'completed',
    isAutoVerifyEnabled: true,
  };

  function setup(orderOverrides: Record<string, unknown> = {}) {
    const order = {
      id: 'order-1',
      orgId: 'org-1',
      integrationId: 'int-1',
      externalOrderId: 'manual-1',
      orderNumber: 'A-1',
      customerPhone: '+201001234567',
      customerName: 'Customer',
      customerEmail: null,
      totalPrice: '100.00',
      currency: 'EGP',
      paymentMethod: 'cash_on_delivery',
      rawPayload: {},
      createdAt: '2026-09-05T00:00:00.000Z',
      integration,
      verifications: [],
      webhookEvents: [
        {
          id: 'event-1',
          platform: 'standalone',
          jobType: 'order.create',
          status: 'skipped',
          lastError: 'plan_limit_reached',
        },
      ],
      ...orderOverrides,
    };
    const verification = order.verifications[0] as
      | {
          id: string;
          status: string;
          metadata?: { reason?: string };
          messageDispatches?: Array<{ state: string }>;
        }
      | undefined;
    const event = order.webhookEvents[0] as
      | { status: string; lastError: string | null }
      | undefined;
    const reason = verification?.metadata?.reason ?? event?.lastError ?? null;
    const hasUnknownDispatch = verification?.messageDispatches?.some(
      (dispatch) => dispatch.state === 'outcome_unknown',
    );
    const retryableReasons = new Set([
      'plan_limit_reached',
      'integration_inactive',
      'billing_not_active',
      'provider_not_accepted',
    ]);
    const blockedEventReasons = new Set([
      'integration_inactive',
      'billing_not_active',
      'plan_limit_reached',
      'auto_verify_disabled',
      'onboarding_incomplete',
    ]);
    const retryGuardStatus = verification
      ? verification.status === 'confirmed' ||
        verification.status === 'canceled'
        ? verification.status
        : hasUnknownDispatch ||
            (!verification.messageDispatches?.length &&
              reason === 'provider_outcome_unknown')
          ? 'review_required'
          : verification.status === 'failed' &&
              retryableReasons.has(reason ?? '')
            ? 'blocked'
            : verification.status
      : !event || event.status === 'pending'
        ? 'accepted'
        : event.status === 'processing'
          ? 'processing'
          : ['non_cod_payment_method', 'missing_payment_signal'].includes(
                reason ?? '',
              )
            ? 'ineligible'
            : blockedEventReasons.has(reason ?? '')
              ? 'blocked'
              : 'failed';
    const dashboardOrder = {
      ...order,
      platformType: 'standalone',
      isTest: false,
      verificationId: verification?.id ?? null,
      verificationStatus: verification?.status ?? null,
      verificationMetadata: verification?.metadata ?? null,
      lastSentAt: null,
      deliveredAt: null,
      readAt: null,
      confirmedAt: null,
      canceledAt: null,
      expiredAt: null,
      noReplyAt: null,
      followUpAttempts: 0,
      followUpSentAt: null,
      retryGuardStatus,
      retryGuardReason:
        reason === 'provider_outcome_unknown' &&
        verification?.messageDispatches?.length
          ? null
          : reason,
      retryGuardRetryable:
        retryGuardStatus === 'blocked' ||
        Boolean(reason?.startsWith('dispatch_terminal:')),
    };
    const orders = {
      findById: jest.fn().mockResolvedValue(order),
      findDashboardOrderById: jest.fn().mockResolvedValue(dashboardOrder),
    };
    const integrations = {
      findByOrg: jest.fn().mockResolvedValue([integration]),
    };
    const billing = {
      hasAvailableSlot: jest.fn().mockResolvedValue({ available: true }),
      readEntitlement: jest.fn().mockResolvedValue({
        consumedCount: 12,
        includedLimit: 100,
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
      }),
    };
    const dispatcher = { dispatchById: jest.fn() };
    const events = {
      resetForRedispatch: jest.fn().mockResolvedValue({ id: 'event-1' }),
    };
    const eligibility = {
      evaluateOrderForVerification: jest.fn().mockReturnValue({
        eligible: true,
        reason: 'cod_match',
      }),
    };
    const service = new OrdersService(
      orders as never,
      integrations as never,
      {} as never,
      {} as never,
      {} as never,
      billing as never,
      dispatcher as never,
      events as never,
      eligibility as never,
    );
    return {
      service,
      dashboardOrder,
      orders,
      integrations,
      billing,
      dispatcher,
      events,
      eligibility,
    };
  }

  it('redispatches a recovered blocked Standalone order', async () => {
    const { service, events, dispatcher } = setup();

    await expect(
      service.retryOrderVerification(user, 'order-1'),
    ).resolves.toEqual({
      orderId: 'order-1',
      lifecycle: {
        status: 'accepted',
        reason: null,
        verification_id: null,
        retryable: false,
      },
      duplicate: false,
    });
    expect(events.resetForRedispatch).toHaveBeenCalledWith({
      id: 'event-1',
      orderId: 'order-1',
    });
    expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
  });

  it('redispatches a blocked Shopify order through the same neutral path', async () => {
    const { service, events, dispatcher } = setup({
      integration: {
        ...integration,
        platformType: 'shopify',
        platformStoreUrl: 'demo.myshopify.com',
      },
      webhookEvents: [
        {
          id: 'event-1',
          platform: 'shopify',
          jobType: 'order.create',
          status: 'skipped',
          lastError: 'plan_limit_reached',
        },
      ],
    });

    await expect(
      service.retryOrderVerification(user, 'order-1'),
    ).resolves.toMatchObject({ orderId: 'order-1', duplicate: false });
    expect(events.resetForRedispatch).toHaveBeenCalledWith({
      id: 'event-1',
      orderId: 'order-1',
    });
    expect(dispatcher.dispatchById).toHaveBeenCalledWith('event-1');
  });

  it('returns an idempotent duplicate while processing', async () => {
    const { service, events } = setup({
      webhookEvents: [
        {
          id: 'event-1',
          platform: 'standalone',
          jobType: 'order.create',
          status: 'processing',
          lastError: null,
        },
      ],
    });
    await expect(
      service.retryOrderVerification(user, 'order-1'),
    ).resolves.toMatchObject({ duplicate: true });
    expect(events.resetForRedispatch).not.toHaveBeenCalled();
  });

  it('blocks merchant retry while provider review is required', async () => {
    const { service } = setup({
      verifications: [
        {
          id: 'verification-1',
          status: 'failed',
          metadata: { reason: 'provider_outcome_unknown' },
          messageDispatches: [{ state: 'outcome_unknown' }],
        },
      ],
    });
    await expect(
      service.retryOrderVerification(user, 'order-1'),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_RETRY_REVIEW_REQUIRED' },
    });
  });

  it('does not preserve a stale review reason after ledger acceptance', async () => {
    // The verification still carries `provider_outcome_unknown` from the
    // attempt that stalled, but the ledger has since accepted the send. The
    // guard must read the ledger, not the stale metadata, or a delivered
    // message would be held for review forever.
    const { service } = setup({
      verifications: [
        {
          id: 'verification-1',
          status: 'sent',
          metadata: { reason: 'provider_outcome_unknown' },
          messageDispatches: [{ state: 'accepted' }],
        },
      ],
    });

    await expect(
      service.retryOrderVerification(user, 'order-1'),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_RETRY_NOT_ALLOWED' },
    });
  });

  it('enforces role and organization isolation', async () => {
    const { service, orders } = setup();
    await expect(
      service.retryOrderVerification({ ...user, role: 'viewer' }, 'order-1'),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_RETRY_ROLE_REQUIRED' },
    });
    orders.findById.mockResolvedValue({
      ...(await orders.findById('order-1')),
      orgId: 'org-2',
    });
    await expect(
      service.retryOrderVerification(user, 'order-1'),
    ).rejects.toMatchObject({
      response: { code: 'MANUAL_ORDER_NOT_FOUND' },
    });
  });
});
