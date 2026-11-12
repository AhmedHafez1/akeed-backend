import type { Job } from 'bullmq';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { WebhookJobType } from './webhook-queue.constants';
import type { WebhookJobPayload } from './interfaces/webhook-job.interface';
import type {
  WebhookNormalizationResult,
  WebhookOrderNormalizer,
} from './interfaces/webhook-normalizer.interface';
import type { NormalizedOrder } from '../../shared/interfaces/order.interface';

const RECEIVED_AT = '2026-11-10T16:13:00.000Z';

function payload(
  overrides: Partial<WebhookJobPayload> = {},
): WebhookJobPayload {
  return {
    webhookEventId: 'event-1',
    platform: 'shopify',
    jobType: WebhookJobType.ORDER_CREATE,
    idempotencyKey: 'webhook-id-1',
    storeDomain: 'test.myshopify.com',
    orgId: 'org-1',
    integrationId: 'int-1',
    rawPayload: { id: 5551, payment_gateway_names: ['manual'] },
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function order(): NormalizedOrder {
  return {
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: '5551',
    customerPhone: '+201000000000',
    totalPrice: '100.00',
    currency: 'EGP',
    paymentMethod: 'manual',
  };
}

function setup(
  options: {
    normalized?: WebhookNormalizationResult;
    hubResult?: Record<string, unknown>;
    integration?: Record<string, unknown> | null;
    recordError?: Error;
    normalizers?: WebhookOrderNormalizer[];
  } = {},
) {
  const events = {
    claimForProcessing: jest.fn().mockResolvedValue('claimed'),
    markSkipped: jest.fn(),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
    markProcessingRetryable: jest.fn(),
    linkOrder: jest.fn(),
  };
  const integrations = {
    findBySourceIdentity: jest
      .fn()
      .mockResolvedValue(
        options.integration === undefined
          ? { id: 'int-1', orgId: 'org-1', isActive: true }
          : options.integration,
      ),
  };
  const describeIntake = jest.fn((raw: Record<string, unknown>) => ({
    externalOrderId: String(raw.id),
    paymentMethod: 'manual',
  }));
  const normalizer: WebhookOrderNormalizer = {
    platform: 'shopify',
    normalizeOrder: jest.fn(() =>
      options.normalized === undefined ? order() : options.normalized,
    ),
    describeIntake,
  };
  const hub = {
    handleNewOrder: jest
      .fn()
      .mockResolvedValue(
        options.hubResult ?? { status: 'verification_created', orderId: 'o1' },
      ),
  };
  const intake = {
    record: options.recordError
      ? jest.fn().mockRejectedValue(options.recordError)
      : jest.fn().mockResolvedValue(true),
  };
  const processor = new WebhookQueueProcessor(
    options.normalizers ?? [normalizer],
    events as never,
    integrations as never,
    hub as never,
    [],
    intake as never,
  );
  const run = (data = payload()) =>
    processor.process({
      id: 'job-1',
      data,
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as Job<WebhookJobPayload>);
  return { run, events, intake, describeIntake, processor };
}

describe('WebhookQueueProcessor order intake', () => {
  it('counts an eligible order with its own id and payment method', async () => {
    const { run, events, intake } = setup();

    await run();

    expect(events.markCompleted).toHaveBeenCalledWith('event-1');
    expect(intake.record).toHaveBeenCalledWith({
      integrationId: 'int-1',
      externalOrderId: '5551',
      receivedAt: new Date(RECEIVED_AT),
      outcome: 'eligible',
      skipReason: null,
      paymentMethod: 'manual',
    });
  });

  it.each([
    'non_cod_payment_method',
    'missing_payment_signal',
    'auto_verify_disabled',
    'onboarding_incomplete',
    'billing_not_active',
  ])('counts a hub skip as skipped with reason %s', async (reason) => {
    const { run, events, intake } = setup({
      hubResult: { skipped: true, reason },
    });

    await run();

    expect(events.markSkipped).toHaveBeenCalledWith('event-1', reason);
    expect(intake.record).toHaveBeenCalledWith(
      expect.objectContaining({
        externalOrderId: '5551',
        outcome: 'skipped',
        skipReason: reason,
        paymentMethod: 'manual',
      }),
    );
  });

  it.each([
    [
      'a normalizer skip',
      { skipped: true, reason: 'non_cod_payment_method' },
      'non_cod_payment_method',
    ],
    ['a payload that cannot be normalized', null, 'normalisation_failed'],
  ] as const)(
    'reads the order id from the payload for %s',
    async (_name, normalized, reason) => {
      const { run, intake, describeIntake } = setup({ normalized });

      await run();

      expect(describeIntake).toHaveBeenCalledWith(payload().rawPayload);
      expect(intake.record).toHaveBeenCalledWith(
        expect.objectContaining({
          externalOrderId: '5551',
          outcome: 'skipped',
          skipReason: reason,
          paymentMethod: 'manual',
        }),
      );
    },
  );

  it('counts a skip for an inactive store against that store', async () => {
    const { run, intake } = setup({
      integration: { id: 'int-1', orgId: 'org-1', isActive: false },
    });

    await run();

    expect(intake.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'skipped',
        skipReason: 'integration_inactive',
      }),
    );
  });

  it('falls back to the event key when no normalizer can read the payload', async () => {
    const { run, intake } = setup({ normalizers: [] });

    await run();

    expect(intake.record).toHaveBeenCalledWith(
      expect.objectContaining({
        externalOrderId: 'event:webhook-id-1',
        skipReason: 'no_normalizer:shopify',
        paymentMethod: undefined,
      }),
    );
  });

  it.each([
    ['no store', payload({ integrationId: null })],
    ['no organization', payload({ orgId: null })],
  ])('does not count an event with %s', async (_name, data) => {
    const { run, intake, events } = setup();

    await run(data);

    expect(events.markSkipped).toHaveBeenCalled();
    expect(intake.record).not.toHaveBeenCalled();
  });

  it('does not count an event whose store identity does not match', async () => {
    const { run, intake, events } = setup({ integration: null });

    await run();

    expect(events.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'source_identity_mismatch',
    );
    expect(intake.record).not.toHaveBeenCalled();
  });

  it('never changes the outcome when counting fails', async () => {
    const { run, events, processor } = setup({
      recordError: new Error('db unavailable'),
    });
    const warn = jest
      .spyOn(processor['logger'], 'warn')
      .mockImplementation(() => undefined);

    await expect(run()).resolves.toBeUndefined();

    expect(events.markCompleted).toHaveBeenCalledWith('event-1');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain(
      'order-intake-record',
    );
  });
});
