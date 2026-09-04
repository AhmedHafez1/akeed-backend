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
  };
  const dispatcher = {
    dispatchById: jest.fn<Promise<string>, [string]>(),
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
