import type { Job } from 'bullmq';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { WebhookJobType, type PlatformType } from './webhook-queue.constants';
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
  const normalizedOrder = Object.prototype.hasOwnProperty.call(
    options,
    'normalizedOrder',
  )
    ? options.normalizedOrder
    : buildOrder();

  const webhookEventsRepo = {
    markProcessing: jest.fn(),
    markSkipped: jest.fn(),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
  };

  const integrationsRepo = {
    findByPlatformDomain: jest.fn().mockResolvedValue(
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
    handleNewOrder: jest.fn(),
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
  it('marks a valid order-create event completed after hub processing', async () => {
    const { processor, webhookEventsRepo, normalizeOrder, verificationHub } =
      createMocks();
    const payload = buildPayload();

    await processor.process(buildJob(payload));

    expect(webhookEventsRepo.markProcessing).toHaveBeenCalledWith('event-1');
    expect(normalizeOrder).toHaveBeenCalledWith(
      payload.rawPayload,
      'int-1',
      'org-1',
    );
    expect(verificationHub.handleNewOrder).toHaveBeenCalledTimes(1);
    expect(webhookEventsRepo.markCompleted).toHaveBeenCalledWith('event-1');
    expect(webhookEventsRepo.markSkipped).not.toHaveBeenCalled();
  });

  it('does not overwrite skipped no-integration events as completed', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration: null,
    });

    await processor.process(buildJob(buildPayload()));

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'no_integration_found',
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

  it.each([
    [
      'pending',
      { id: 'int-1', orgId: 'org-1', isActive: true, billingStatus: 'pending' },
    ],
    [
      'null',
      { id: 'int-1', orgId: 'org-1', isActive: true, billingStatus: null },
    ],
    [
      'cancelled',
      {
        id: 'int-1',
        orgId: 'org-1',
        isActive: true,
        billingStatus: 'cancelled',
      },
    ],
    [
      'error',
      { id: 'int-1', orgId: 'org-1', isActive: true, billingStatus: 'error' },
    ],
    [
      'frozen',
      { id: 'int-1', orgId: 'org-1', isActive: true, billingStatus: 'frozen' },
    ],
  ])('skips webhook when billing status is %s', async (_label, integration) => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration,
    });

    await processor.process(buildJob(buildPayload()));

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      expect.stringContaining('billing_blocked'),
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });

  it('processes webhook when billing status is active', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration: {
        id: 'int-1',
        orgId: 'org-1',
        isActive: true,
        billingStatus: 'active',
      },
    });

    await processor.process(buildJob(buildPayload()));

    expect(verificationHub.handleNewOrder).toHaveBeenCalledTimes(1);
    expect(webhookEventsRepo.markCompleted).toHaveBeenCalledWith('event-1');
  });

  it('processes webhook when billing status is not_required', async () => {
    const { processor, webhookEventsRepo, verificationHub } = createMocks({
      integration: {
        id: 'int-1',
        orgId: 'org-1',
        isActive: true,
        billingStatus: 'not_required',
      },
    });

    await processor.process(buildJob(buildPayload()));

    expect(verificationHub.handleNewOrder).toHaveBeenCalledTimes(1);
    expect(webhookEventsRepo.markCompleted).toHaveBeenCalledWith('event-1');
  });
});
