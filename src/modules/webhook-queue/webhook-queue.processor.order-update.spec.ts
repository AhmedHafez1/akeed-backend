import type { Job } from 'bullmq';
import { WebhookQueueProcessor } from './webhook-queue.processor';
import { WebhookJobType } from './webhook-queue.constants';
import type { WebhookJobPayload } from './interfaces/webhook-job.interface';
import type {
  WebhookOrderUpdateHandler,
  WebhookOrderUpdateResult,
} from './interfaces/webhook-order-update-handler.interface';

function buildJob(
  overrides: Partial<WebhookJobPayload> = {},
): Job<WebhookJobPayload> {
  const data: WebhookJobPayload = {
    webhookEventId: 'event-1',
    platform: 'easyorders',
    jobType: WebhookJobType.ORDER_UPDATE,
    idempotencyKey: 'order.status:int-1:order-1:pending:confirmed',
    storeDomain: 'easyorders:org-1',
    orgId: 'org-1',
    integrationId: 'int-1',
    rawPayload: { order_id: 'order-1', new_status: 'confirmed' },
    receivedAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
  return {
    id: 'job-1',
    data,
    attemptsMade: 1,
    opts: {},
  } as Job<WebhookJobPayload>;
}

function setup(
  options: {
    result?: WebhookOrderUpdateResult;
    integration?: Record<string, unknown> | null;
    withHandler?: boolean;
  } = {},
) {
  const webhookEventsRepo = {
    claimForProcessing: jest.fn().mockResolvedValue('claimed'),
    markSkipped: jest.fn(),
    markCompleted: jest.fn(),
  };
  const integrationsRepo = {
    findBySourceIdentity: jest
      .fn()
      .mockResolvedValue(
        options.integration === undefined
          ? { id: 'int-1', orgId: 'org-1', isActive: true }
          : options.integration,
      ),
  };
  const verificationHub = { handleNewOrder: jest.fn() };
  const handleOrderUpdate = jest
    .fn<
      Promise<WebhookOrderUpdateResult>,
      [Record<string, unknown>, string, string]
    >()
    .mockResolvedValue(
      options.result ?? { skipped: true, reason: 'reflected_outcome' },
    );
  const handler: WebhookOrderUpdateHandler = {
    platform: 'easyorders',
    handleOrderUpdate,
  };
  const processor = new WebhookQueueProcessor(
    [],
    webhookEventsRepo as never,
    integrationsRepo as never,
    verificationHub as never,
    options.withHandler === false ? [] : [handler],
  );
  return {
    processor,
    webhookEventsRepo,
    integrationsRepo,
    verificationHub,
    handleOrderUpdate,
  };
}

describe('WebhookQueueProcessor order updates', () => {
  it('gives the handler the trusted source, never ids from the payload', async () => {
    const { processor, handleOrderUpdate, integrationsRepo } = setup();
    const job = buildJob({
      rawPayload: { order_id: 'order-1', org_id: 'org-evil' },
    });

    await processor.process(job);

    expect(integrationsRepo.findBySourceIdentity).toHaveBeenCalledWith({
      id: 'int-1',
      orgId: 'org-1',
      platformType: 'easyorders',
      platformStoreUrl: 'easyorders:org-1',
    });
    expect(handleOrderUpdate).toHaveBeenCalledWith(
      job.data.rawPayload,
      'int-1',
      'org-1',
    );
  });

  it('records the handler’s skip reason and never reaches the hub', async () => {
    const { processor, webhookEventsRepo, verificationHub } = setup();

    await processor.process(buildJob());

    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'reflected_outcome',
    );
    expect(webhookEventsRepo.markCompleted).not.toHaveBeenCalled();
    expect(verificationHub.handleNewOrder).not.toHaveBeenCalled();
  });

  it('completes an event its handler handled', async () => {
    const { processor, webhookEventsRepo } = setup({
      result: { handled: true },
    });

    await processor.process(buildJob());

    expect(webhookEventsRepo.markCompleted).toHaveBeenCalledWith('event-1');
    expect(webhookEventsRepo.markSkipped).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown source', null, 'source_identity_mismatch'],
    [
      'a disconnected source',
      { id: 'int-1', orgId: 'org-1', isActive: false },
      'integration_inactive',
    ],
  ])(
    'skips %s without calling the handler',
    async (_name, integration, reason) => {
      const { processor, webhookEventsRepo, handleOrderUpdate } = setup({
        integration,
      });

      await processor.process(buildJob());

      expect(handleOrderUpdate).not.toHaveBeenCalled();
      expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
        'event-1',
        reason,
      );
    },
  );

  it('keeps a platform without a handler unhandled, as before', async () => {
    const { processor, webhookEventsRepo, integrationsRepo } = setup({
      withHandler: false,
    });

    await processor.process(buildJob({ platform: 'shopify' }));

    expect(integrationsRepo.findBySourceIdentity).not.toHaveBeenCalled();
    expect(webhookEventsRepo.markSkipped).toHaveBeenCalledWith(
      'event-1',
      'unhandled_job_type:order.update',
    );
  });
});
