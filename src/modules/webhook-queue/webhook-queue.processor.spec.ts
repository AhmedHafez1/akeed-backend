import type { Job } from 'bullmq';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { WebhookJobType } from './webhook-queue.constants';
import type { PlatformType } from '../../shared/interfaces/commerce-source.interface';
import type { WebhookJobPayload } from './interfaces/webhook-job.interface';
import type { WebhookOrderNormalizer } from './interfaces/webhook-normalizer.interface';
import type { NormalizedOrder } from '../../shared/interfaces/order.interface';

function buildPayload(
  overrides: Partial<WebhookJobPayload> = {},
): WebhookJobPayload {
  return {
    webhookEventId: 'event-1',
    platform: 'shopify',
    jobType: WebhookJobType.ORDER_CREATE,
    idempotencyKey: 'idempotency-1',
    storeDomain: 'test.myshopify.com',
    orgId: 'org-1',
    integrationId: 'int-1',
    rawPayload: { id: 123 },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildJob(
  payload: WebhookJobPayload,
  overrides: Partial<Job<WebhookJobPayload>> = {},
): Job<WebhookJobPayload> {
  return {
    id: `${payload.platform}-${payload.idempotencyKey}`,
    data: payload,
    attemptsMade: 1,
    opts: { attempts: 1 },
    ...overrides,
  } as Job<WebhookJobPayload>;
}

function buildOrder(): NormalizedOrder {
  return {
    orgId: 'org-1',
    integrationId: 'int-1',
    externalOrderId: 'ext-order-1',
    orderNumber: '1001',
    customerPhone: '+966500000000',
    customerName: 'Test Customer',
    totalPrice: '100.00',
    currency: 'SAR',
    paymentMethod: 'cod',
    rawPayload: { id: 123 },
  };
}

function createMocks(
  options: {
    integration?: Record<string, unknown> | null;
    normalizedOrder?: NormalizedOrder | null;
    normalizerPlatform?: PlatformType;
  } = {},
) {
  const normalizedOrder =
    options.normalizedOrder === undefined
      ? buildOrder()
      : options.normalizedOrder;

  const webhookEventsRepo = {
    claimForProcessing: jest.fn().mockResolvedValue('claimed'),
    markProcessingRetryable: jest.fn(),
    markSkipped: jest.fn(),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
  };

  const integrationsRepo = {
    findBySourceIdentity: jest.fn().mockResolvedValue(
      options.integration === undefined
        ? {
            id: 'int-1',
            orgId: 'org-1',
            isActive: true,
            billingStatus: 'active',
          }
        : options.integration,
    ),
  };

  const normalizeOrder = jest.fn(() => normalizedOrder);
  const normalizer: WebhookOrderNormalizer = {
    platform: options.normalizerPlatform ?? 'shopify',
    normalizeOrder,
  };

  const verificationHub = {
    handleNewOrder: jest.fn().mockResolvedValue({
      status: 'verification_created',
      verificationId: 'ver-1',
    }),
  };

  const processor = new WebhookQueueProcessor(
    [normalizer],
    webhookEventsRepo as never,
    integrationsRepo as never,
    verificationHub as never,
  );

  return {
    processor,
    webhookEventsRepo,
    integrationsRepo,
    normalizer,
    normalizeOrder,
    verificationHub,
  };
}

describe('WebhookQueueProcessor', () => {
  it('explicitly skips a runtime payload with an unknown platform', async () => {
    const { processor, webhookEventsRepo, integrationsRepo } = createMocks();
    const payload = { ...buildPayload(), platform: 'magento' };

    await processor.process(buildJob(payload as never));

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'unsupported_platform:magento',
    );
    expect(integrationsRepo.findBySourceIdentity).not.toHaveBeenCalled();
  });

  it('marks a valid order-create event completed after hub processing', async () => {
    const { processor, webhookEventsRepo, normalizeOrder, verificationHub } =
      createMocks();
    const payload = buildPayload();

    await processor.process(buildJob(payload));

    expect(webhookEventsRepo.claimForProcessing).toHaveBeenCalledWith(
      'event-1',
      expect.any(String),
    );
    expect(normalizeOrder).toHaveBeenCalledWith(
      payload.rawPayload,
      'int-1',
      'org-1',
    );
    expect(verificationHub.handleNewOrder).toHaveBeenCalledTimes(1);
    expect(webhookEventsRepo.markCompleted).toHaveBeenCalledWith('event-1');
    expect(webhookEventsRepo.markSkipped).not.toHaveBeenCalled();
  });

  it.each([
    'non_cod_payment_method',
    'missing_payment_signal',
    'billing_not_active',
    'plan_limit_reached',
    'auto_verify_disabled',
    'onboarding_incomplete',
  ])(
    'persists a terminal hub result as %s instead of completed',
    async (reason) => {
      const { processor, webhookEventsRepo, verificationHub } = createMocks();
      verificationHub.handleNewOrder.mockResolvedValue({
        skipped: true,
        reason,
      });

      await processor.process(buildJob(buildPayload()));

      expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
        'event-1',
        reason,
      );
      expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    },
  );

  it('does not overwrite skipped no-integration events as completed', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration: null,
    });

    await processor.process(buildJob(buildPayload()));

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'source_identity_mismatch',
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });

  it('does not overwrite skipped normalisation failures as completed', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      normalizedOrder: null,
    });

    await processor.process(buildJob(buildPayload()));

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'normalisation_failed',
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });

  it('marks webhook event failed only after job attempts are exhausted', async () => {
    const { processor, webhookEventsRepo } = createMocks();
    const payload = buildPayload();

    await processor.onFailed(
      buildJob(payload, { attemptsMade: 4, opts: { attempts: 5 } }),
      new Error('temporary outage'),
    );

    expect(webhookEventsRepo.markFailed).not.toHaveBeenCalled();
    expect(webhookEventsRepo.markProcessingRetryable).toHaveBeenCalledWith(
      'event-1',
      'temporary outage',
      4,
    );

    await processor.onFailed(
      buildJob(payload, { attemptsMade: 5, opts: { attempts: 5 } }),
      new Error('permanent outage'),
    );

    expect(webhookEventsRepo.markFailed).toHaveBeenCalledWith(
      'event-1',
      'permanent outage',
      5,
    );
  });

  it('delegates to verification hub regardless of billing status', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration: {
        id: 'int-1',
        orgId: 'org-1',
        isActive: true,
        billingStatus: 'pending',
      },
    });

    await processor.process(buildJob(buildPayload()));

    expect(verificationHub.handleNewOrder).toHaveBeenCalledTimes(1);
    expect(webhookEventsRepo.markCompleted).toHaveBeenCalledWith('event-1');
  });

  it('skips and marks skipped for unhandled job types', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks();
    const payload = buildPayload({
      jobType: WebhookJobType.APP_UNINSTALLED,
    });

    await processor.process(buildJob(payload));

    expect(webhookEventsRepo.claimForProcessing).toHaveBeenCalledWith(
      'event-1',
      expect.any(String),
    );
    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      `unhandled_job_type:${WebhookJobType.APP_UNINSTALLED}`,
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });

  it('handles onFailed gracefully when job is undefined', async () => {
    const { processor, webhookEventsRepo } = createMocks();

    await processor.onFailed(undefined, new Error('unknown error'));

    expect(webhookEventsRepo.markFailed).not.toHaveBeenCalled();
  });

  it.each(['busy', 'terminal'] as const)(
    'does not repeat business effects when the persisted event is %s',
    async (claim) => {
      const { processor, webhookEventsRepo, verificationHub } = createMocks();
      webhookEventsRepo.claimForProcessing.mockResolvedValue(claim);

      await processor.process(buildJob(buildPayload()));

      expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
      expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    },
  );

  it('skips webhook when no normalizer is registered for the platform', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      normalizerPlatform: 'salla',
      integration: {
        id: 'int-1',
        orgId: 'org-1',
        isActive: true,
        billingStatus: 'active',
      },
    });
    const payload = buildPayload({ platform: 'shopify' });

    await processor.process(buildJob(payload));

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'no_normalizer:shopify',
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });

  it('skips when the queued event has no trusted source identity', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration: null,
    });

    await processor.process(
      buildJob(buildPayload({ orgId: null, integrationId: null })),
    );

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'missing_source_identity',
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });

  it('skips a queued order after its source is disconnected', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration: {
        id: 'int-1',
        orgId: 'org-1',
        isActive: false,
        billingStatus: 'cancelled',
      },
    });

    await processor.process(buildJob(buildPayload()));

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'integration_inactive',
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });
});
