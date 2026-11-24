import { DelayedError, type Job } from 'bullmq';
import { VerificationAutomationProcessor } from './verification-automation.processor';
import {
  VerificationAutomationJobType,
  type VerificationAutomationJobPayload,
} from './verification-automation.constants';
import { SHIPPING_NOTIFICATIONS_CONFIG } from '../../shared/config/shipping-notifications.config';

const ORG = 'org-1';
const VERIFICATION = 'ver-1';
const RECORD = 'ship-1';

function context(overrides: Record<string, unknown> = {}) {
  return {
    notification: {
      id: RECORD,
      orgId: ORG,
      verificationId: VERIFICATION,
      status: 'pending',
      dispatchId: null,
    },
    verificationStatus: 'confirmed',
    verificationCanceledAt: null,
    merchantCanceledAt: null,
    orderIsTest: false,
    orderCreatedAt: new Date().toISOString(),
    customerPhone: '+201001234567',
    shippingNotificationsEnabled: true,
    ...overrides,
  };
}

const integration = {
  id: 'int-1',
  orgId: ORG,
  quietHoursEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: 'Africa/Cairo',
};

function setup(options: {
  enabled?: boolean;
  record?: ReturnType<typeof context> | null;
  outcome?: { status: string; reason?: string; recoveryKind?: string };
  quietHours?: boolean;
}) {
  const shipping = {
    findSendContext: jest
      .fn()
      .mockResolvedValue(
        options.record === undefined ? context() : options.record,
      ),
    markFailed: jest.fn().mockResolvedValue(true),
    findByVerification: jest.fn().mockResolvedValue({ id: RECORD }),
  };
  const send = {
    sendShipped: jest
      .fn()
      .mockResolvedValue(options.outcome ?? { status: 'sent' }),
    resumeSenderRecovery: jest
      .fn()
      .mockResolvedValue(options.outcome ?? { status: 'sent' }),
    acknowledgeRecoveryAutomation: jest.fn(),
    hasSenderRecovery: jest.fn().mockResolvedValue(false),
  };
  const verificationsRepo = {
    findById: jest
      .fn()
      .mockResolvedValue({ id: VERIFICATION, orgId: ORG, orderId: 'order-1' }),
  };
  const ordersRepo = {
    findById: jest.fn().mockResolvedValue({
      id: 'order-1',
      orgId: ORG,
      integrationId: integration.id,
      integration: options.quietHours
        ? {
            ...integration,
            quietHoursEnabled: true,
            quietHoursStart: '00:00',
            quietHoursEnd: '23:59',
          }
        : integration,
    }),
  };
  const hub = { scheduleFollowUpAndEscalation: jest.fn() };
  const reconfirmations = { afterSenderRecovery: jest.fn() };
  const config = {
    get: (key: string) =>
      key === SHIPPING_NOTIFICATIONS_CONFIG
        ? { enabled: options.enabled ?? true }
        : undefined,
  };
  const processor = new VerificationAutomationProcessor(
    verificationsRepo as never,
    ordersRepo as never,
    send as never,
    hub as never,
    {} as never,
    {} as never,
    { prepareRecoverySchedule: jest.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    reconfirmations as never,
    undefined,
    shipping as never,
    config as never,
  );
  return { processor, shipping, send, hub, reconfirmations };
}

function job(
  name = VerificationAutomationJobType.SHIPPING_SEND,
  data: Partial<VerificationAutomationJobPayload> = {},
) {
  return {
    id: 'job-1',
    name,
    data: {
      verificationId: VERIFICATION,
      orgId: ORG,
      shippingNotificationId: RECORD,
      scheduledAt: new Date().toISOString(),
      ...data,
    },
    moveToDelayed: jest.fn(),
  } as unknown as Job<VerificationAutomationJobPayload>;
}

describe('VerificationAutomationProcessor: shipping_send', () => {
  it('sends a pending, eligible record and leaves a sent one to the ledger', async () => {
    const { processor, send, shipping } = setup({});
    await processor.process(job(), 'token');
    expect(send.sendShipped).toHaveBeenCalledWith(VERIFICATION);
    expect(shipping.markFailed).not.toHaveBeenCalled();
  });

  it('reads the record scoped to the job org', async () => {
    const { processor, shipping } = setup({});
    await processor.process(job(), 'token');
    expect(shipping.findSendContext).toHaveBeenCalledWith({
      orgId: ORG,
      shippingNotificationId: RECORD,
    });
  });

  it.each([
    ['the env switch is off', { enabled: false }],
    ['the record is gone', { record: null }],
    [
      'the record was already handled',
      {
        record: context({
          notification: { ...context().notification, status: 'sent' },
        }),
      },
    ],
    [
      'the store switched it off',
      { record: context({ shippingNotificationsEnabled: false }) },
    ],
    [
      'the record belongs to another order',
      {
        record: context({
          notification: { ...context().notification, verificationId: 'other' },
        }),
      },
    ],
    ['the order is a test', { record: context({ orderIsTest: true }) }],
  ])('sends nothing when %s', async (_label, options) => {
    const { processor, send, shipping } = setup(options);
    await processor.process(job(), 'token');
    expect(send.sendShipped).not.toHaveBeenCalled();
    expect(shipping.markFailed).not.toHaveBeenCalled();
  });

  it.each([
    [
      'cancelled since the event',
      context({ merchantCanceledAt: '2026-11-20T00:00:00Z' }),
      'order_cancelled',
    ],
    [
      'older than 30 days',
      context({ orderCreatedAt: '2026-01-01T00:00:00Z' }),
      'order_too_old',
    ],
  ])(
    'fails a record whose order was %s, without sending',
    async (_label, record, reason) => {
      const { processor, send, shipping } = setup({ record });
      await processor.process(job(), 'token');
      expect(send.sendShipped).not.toHaveBeenCalled();
      expect(shipping.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG,
          shippingNotificationId: RECORD,
          reason,
        }),
      );
    },
  );

  it.each([
    [{ status: 'skipped', reason: 'allowance_low' }, 'allowance_low'],
    [{ status: 'skipped', reason: 'no_allowance' }, 'no_allowance'],
    [{ status: 'skipped', reason: 'no_phone' }, 'no_phone'],
    [
      { status: 'skipped', reason: 'template_unavailable' },
      'template_unavailable',
    ],
    [{ status: 'failed', reason: 'no_whatsapp' }, 'not_on_whatsapp'],
  ])(
    'writes a refused or failed send onto the record: %j',
    async (outcome, reason) => {
      const { processor, shipping } = setup({ outcome });
      await expect(processor.process(job(), 'token')).resolves.toBeUndefined();
      expect(shipping.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ shippingNotificationId: RECORD, reason }),
      );
    },
  );

  it('holds the send over quiet hours and sends nothing now', async () => {
    const { processor, send } = setup({ quietHours: true });
    const delayed = job();
    await expect(processor.process(delayed, 'token')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(send.sendShipped).not.toHaveBeenCalled();
    expect(
      (delayed as unknown as { moveToDelayed: jest.Mock }).moveToDelayed,
    ).toHaveBeenCalled();
  });
});

describe('VerificationAutomationProcessor: shipping sender recovery', () => {
  it('a sent fallback schedules no confirmation work', async () => {
    const { processor, hub, reconfirmations, send } = setup({
      outcome: { status: 'sent', recoveryKind: 'shipping_shipped' },
    });
    await processor.process(
      job(VerificationAutomationJobType.SENDER_FALLBACK, {
        dispatchId: 'dispatch-1',
        shippingNotificationId: undefined,
      }),
      'token',
    );
    expect(hub.scheduleFollowUpAndEscalation).not.toHaveBeenCalled();
    expect(reconfirmations.afterSenderRecovery).not.toHaveBeenCalled();
    expect(send.acknowledgeRecoveryAutomation).toHaveBeenCalledWith(
      ORG,
      'dispatch-1',
    );
  });

  it('a fallback refused by the reserve fails the record by verification', async () => {
    const { processor, shipping } = setup({
      outcome: {
        status: 'skipped',
        reason: 'allowance_low',
        recoveryKind: 'shipping_shipped',
      },
    });
    await processor.process(
      job(VerificationAutomationJobType.SENDER_FALLBACK, {
        dispatchId: 'dispatch-1',
        shippingNotificationId: undefined,
      }),
      'token',
    );
    expect(shipping.findByVerification).toHaveBeenCalledWith({
      orgId: ORG,
      verificationId: VERIFICATION,
      stage: 'shipped',
    });
    expect(shipping.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'allowance_low' }),
    );
  });
});
